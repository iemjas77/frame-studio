import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { DEFAULT_PROBE_LIMITS, MediaError, ProbeLimits, ProbeResult } from '@fs/media-contracts';
import { rate } from '@fs/timeline-model';

/** Run a tool with structured args (never a shell), a hard timeout and an output cap. */
export function runBounded(cmd: string, args: string[], limits: { timeoutMs: number; maxOutputBytes: number }, signal?: AbortSignal): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: 'buffer', timeout: limits.timeoutMs, maxBuffer: limits.maxOutputBytes, killSignal: 'SIGKILL', windowsHide: true, signal }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
        if (e.code === 'ENOENT') return reject(new MediaError('ToolMissing', `${cmd} not found on PATH`));
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new MediaError('TooMuchOutput', `${cmd} produced more than ${limits.maxOutputBytes} bytes`));
        if (e.killed) return reject(new MediaError('Timeout', `${cmd} exceeded ${limits.timeoutMs} ms`));
        return reject(new MediaError('Unreadable', `${cmd} failed: ${String(stderr).slice(-400) || e.message}`));
      }
      resolve({ stdout: stdout as Buffer, stderr: String(stderr) });
    });
    child.stdin?.end();
  });
}

const HASH_WINDOW = 1024 * 1024;
export async function fingerprintFile(file: string): Promise<{ size: number; headHash: string; tailHash: string }> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat(); const n = Math.min(size, HASH_WINDOW); const buf = Buffer.alloc(n);
    await fh.read(buf, 0, n, 0); const headHash = createHash('sha256').update(buf).digest('hex');
    await fh.read(buf, 0, n, size - n); const tailHash = createHash('sha256').update(buf).digest('hex');
    return { size, headHash, tailHash };
  } finally { await fh.close(); }
}

const frac = (s: string | undefined): [number, number] | null => { if (!s) return null; const m = /^(\d+)\/(\d+)$/.exec(s); if (!m || +m[2]! === 0) return null; return [+m[1]!, +m[2]!]; };
const num = (v: unknown): number | undefined => { const n = typeof v === 'string' ? parseFloat(v) : (v as number); return Number.isFinite(n) ? n : undefined; };

export async function probeMedia(file: string, limits: ProbeLimits = DEFAULT_PROBE_LIMITS, signal?: AbortSignal): Promise<ProbeResult> {
  let st: fs.Stats;
  try { st = await fs.promises.stat(file); } catch { throw new MediaError('NotFound', `file not found: ${file}`); }
  if (!st.isFile()) throw new MediaError('NotAFile', `not a regular file: ${file}`);
  if (st.size === 0) throw new MediaError('Empty', `file is empty: ${file}`);
  if (st.size > limits.maxFileBytes) throw new MediaError('Unreadable', `file exceeds the ${limits.maxFileBytes} byte limit`);
  const { stdout } = await runBounded('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-count_packets', '-i', file], limits, signal);
  let j: any; try { j = JSON.parse(stdout.toString('utf8')); } catch { throw new MediaError('Unreadable', 'ffprobe returned invalid JSON'); }
  const streams: any[] = j.streams ?? []; const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic) ?? streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio'); const warnings: string[] = [];
  if (!v && !a) throw new MediaError('NoStreams', `no decodable video or audio stream in ${file}`);
  const fmtDur = num(j.format?.duration) ?? 0;
  const out: ProbeResult = {
    path: file, size: st.size, container: String(j.format?.format_name ?? 'unknown'), durationSec: fmtDur, startTimecode: j.format?.tags?.timecode ?? v?.tags?.timecode,
    streamCounts: { video: streams.filter((s) => s.codec_type === 'video').length, audio: streams.filter((s) => s.codec_type === 'audio').length, other: streams.filter((s) => !['video', 'audio'].includes(s.codec_type)).length },
    fingerprint: await fingerprintFile(file), warnings,
  };
  if (out.streamCounts.audio > 1) warnings.push(`${out.streamCounts.audio} audio streams; only the first is used in this version`);
  if (v) {
    const r = frac(v.r_frame_rate), avg = frac(v.avg_frame_rate); if (!r) throw new MediaError('Unreadable', 'video stream has no frame rate');
    const rr = rate(r[0], r[1]); const vfr = !!avg && Math.abs(avg[0] / avg[1] - r[0] / r[1]) / (r[0] / r[1]) > 0.01;
    if (vfr) warnings.push('variable frame rate detected: timeline treats the nominal rate; VFR timestamp mapping is not implemented');
    const dur = num(v.duration) ?? fmtDur; let frames = num(v.nb_frames) ?? num(v.nb_read_packets) ?? Math.round(dur * rr.num / rr.den);
    let rotation = 0; const dm = (v.side_data_list ?? []).find((s: any) => s.rotation !== undefined); if (dm) rotation = ((-Number(dm.rotation) % 360) + 360) % 360; else if (v.tags?.rotate) rotation = ((Number(v.tags.rotate) % 360) + 360) % 360;
    const sar = /^(\d+):(\d+)$/.exec(v.sample_aspect_ratio ?? ''); const par = sar && +sar[1]! > 0 && +sar[2]! > 0 ? { num: +sar[1]!, den: +sar[2]! } : { num: 1, den: 1 };
    if (!Number.isFinite(frames) || frames < 1) { frames = Math.max(1, Math.round(dur * rr.num / rr.den)); warnings.push('frame count estimated from duration'); }
    out.video = { codec: v.codec_name, profile: v.profile, width: v.width, height: v.height, rate: rr, frameCount: frames, durationSec: dur, rotation, par, pixFmt: v.pix_fmt, bitDepth: num(v.bits_per_raw_sample),
      primaries: v.color_primaries, transfer: v.color_transfer, matrix: v.color_space, range: v.color_range === 'pc' ? 'full' : v.color_range === 'tv' ? 'limited' : undefined, vfr, hasBFrames: (v.has_b_frames ?? 0) > 0, startSec: num(v.start_time) ?? 0 };
    if (!v.color_primaries && !v.color_space) warnings.push('no colour metadata in file: interpretation is unspecified and NOT guessed');
  }
  if (a) {
    const sr = num(a.sample_rate) ?? 0; if (!sr) throw new MediaError('Unreadable', 'audio stream has no sample rate');
    const dur = num(a.duration) ?? fmtDur; out.audio = { codec: a.codec_name, sampleRate: sr, channels: a.channels, layout: a.channel_layout, durationSec: dur, sampleCount: Math.round(dur * sr), startSec: num(a.start_time) ?? 0 };
  }
  return out;
}
