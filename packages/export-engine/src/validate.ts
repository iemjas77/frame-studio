import { spawn } from 'node:child_process';
import type { ExportCheck } from '@fs/media-contracts';
import { runBounded } from '@fs/media-services';
import type { ExportPlan } from './plan.ts';

export interface ContentOracle {
  /** sequence-frame offsets (relative to export start) to sample, with the source frame number expected there (undefined = expect black/no clip) */
  frames: { outFrame: number; expect: number | null }[];
  /** reads the frame identity out of an 8-bit gray w x h image; null = could not identify (black) */
  read: (gray: Buffer, w: number) => number | null;
}

async function decodeAll(file: string): Promise<{ stderr: string; code: number }> {
  return new Promise((resolve) => { const p = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); let e = ''; p.stderr.on('data', (d) => { e = (e + d).slice(-4000); }); p.on('close', (c) => resolve({ stderr: e, code: c ?? -1 })); });
}

/**
 * Independent verification of an exported file: it only trusts what ffprobe/ffmpeg can read back from the file.
 * The encoder's exit code is not evidence. Returns every check (pass or fail) so the UI can show the evidence.
 */
export async function validateExport(file: string, plan: ExportPlan, oracle?: ContentOracle): Promise<ExportCheck[]> {
  const checks: ExportCheck[] = []; const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  let probe: any;
  try { probe = JSON.parse((await runBounded('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-count_frames', file], { timeoutMs: 120_000, maxOutputBytes: 4_000_000 })).stdout.toString()); }
  catch (e) { add('container readable', false, (e as Error).message); return checks; }
  add('container readable', true, probe.format?.format_name);
  const v = probe.streams.find((s: any) => s.codec_type === 'video'), a = probe.streams.find((s: any) => s.codec_type === 'audio');
  add('video stream present', !!v, v ? `${v.codec_name} ${v.width}x${v.height}` : 'missing');
  add('audio stream present', !!a, a ? `${a.codec_name} ${a.sample_rate} Hz ${a.channels}ch` : 'missing');
  if (v) {
    add('resolution', v.width === plan.width && v.height === plan.height, `${v.width}x${v.height} (expected ${plan.width}x${plan.height})`);
    add('frame rate', v.r_frame_rate === `${plan.rate.num}/${plan.rate.den}`, `${v.r_frame_rate} (expected ${plan.rate.num}/${plan.rate.den})`);
    add('frame count', Number(v.nb_read_frames) === plan.frames, `${v.nb_read_frames} decoded (expected ${plan.frames})`);
  }
  if (a) {
    add('audio format', Number(a.sample_rate) === plan.sampleRate && a.channels === 2, `${a.sample_rate} Hz, ${a.channels} ch (expected ${plan.sampleRate} Hz, 2 ch)`);
    const durFrames = (Number(a.duration) * plan.rate.num) / plan.rate.den; const vdur = plan.frames;
    add('audio duration matches video', Math.abs(durFrames - vdur) <= 1.5, `audio ${durFrames.toFixed(2)} frames vs video ${vdur}`);
    const pcm = await runBounded('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0', '-f', 's16le', '-ac', '2', '-ar', String(plan.sampleRate), 'pipe:1'], { timeoutMs: 120_000, maxOutputBytes: plan.totalSamples * 4 * 2 + 65536 }).catch(() => null);
    if (pcm) { const got = pcm.stdout.length / 4; add('audio sample count', Math.abs(got - plan.totalSamples) <= plan.sampleRate * plan.rate.den / plan.rate.num * 1.5, `${got} samples (expected ${plan.totalSamples} +/- 1.5 frames)`); }
  }
  const d = await decodeAll(file); add('full decode without errors', d.code === 0 && d.stderr.trim() === '', d.stderr.trim() || 'clean');
  if (oracle) {
    const { decodeFrameGray } = await import('@fs/media-services');
    const bad: string[] = [];
    for (const f of oracle.frames) {
      const gray = await decodeFrameGray(file, f.outFrame, plan.rate, plan.width, plan.height); const got = oracle.read(gray, plan.width);
      if (got !== f.expect) bad.push(`out frame ${f.outFrame}: got ${got}, expected ${f.expect}`);
    }
    add('visual content at sampled frames', bad.length === 0, bad.length ? bad.join('; ') : `${oracle.frames.length} frames matched expected source frames`);
  } else add('visual content', true, 'skipped: no content oracle available for this media (frame identity cannot be derived from arbitrary footage)');
  return checks;
}
