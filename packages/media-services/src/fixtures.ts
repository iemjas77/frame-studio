/**
 * Deterministic synthetic fixtures (no third-party media, nothing to license).
 * Every video frame carries its own frame number as a 16-bit black/white strip (40 px cells) in the top rows, so a decoded
 * frame can be identified exactly even after lossy encoding. Audio is a pure sine whose frequency identifies the clip.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const STRIP = "geq=lum='if(lt(Y,40),255*mod(floor(N/pow(2,floor(X/40))),2),lum(X,Y))':cb='if(lt(Y,40),128,cb(X,Y))':cr='if(lt(Y,40),128,cb(X,Y)*0+cr(X,Y))'";
const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });

export interface FixtureSpec { file: string; kind: 'video' | 'audio' | 'derived'; rate?: string; seconds: number; freq: number; gop?: number; bframes?: number; note: string }
export const FIXTURES: Record<string, FixtureSpec> = {
  A: { file: 'A_25fps_10s.mp4', kind: 'video', rate: '25', seconds: 10, freq: 440, gop: 25, bframes: 2, note: '640x360 H.264 25 fps, AAC 48k stereo, 440 Hz' },
  B: { file: 'B_23976_6s.mp4', kind: 'video', rate: '24000/1001', seconds: 6, freq: 880, gop: 48, bframes: 2, note: '640x360 H.264 23.976 fps, 880 Hz' },
  C: { file: 'C_2997_longgop_8s.mp4', kind: 'video', rate: '30000/1001', seconds: 8, freq: 660, gop: 250, bframes: 3, note: '640x360 long-GOP H.264 29.97 fps, 660 Hz' },
  H: { file: 'H_25fps_6s_1k.mp4', kind: 'video', rate: '25', seconds: 6, freq: 1000, gop: 25, bframes: 0, note: '640x360 H.264 25 fps, all-intra-ish GOP 25, 1000 Hz' },
  D: { file: 'D_audio_44k_5s.wav', kind: 'audio', seconds: 5, freq: 330, note: 'mono 44.1 kHz PCM, 330 Hz' },
  E: { file: 'E_rotated90.mp4', kind: 'derived', seconds: 10, freq: 440, note: 'A remuxed with display rotation 90' },
  G: { file: 'G_nonzero_start.mp4', kind: 'derived', seconds: 10, freq: 440, note: 'A remuxed with +3.5 s timestamp offset' },
  F: { file: 'F_corrupt.mp4', kind: 'derived', seconds: 0, freq: 0, note: 'A truncated to 30% of its bytes (damaged)' },
  Z: { file: 'Z_empty.mp4', kind: 'derived', seconds: 0, freq: 0, note: 'zero-byte file' },
};

export function ensureFixtures(dir: string): Record<string, string> {
  fs.mkdirSync(dir, { recursive: true }); const out: Record<string, string> = {};
  for (const [k, s] of Object.entries(FIXTURES)) out[k] = path.join(dir, s.file);
  const need = (k: string) => !fs.existsSync(out[k]!) || fs.statSync(out[k]!).size === 0 && k !== 'Z';
  for (const k of ['A', 'B', 'C', 'H'] as const) {
    if (!need(k)) continue; const s = FIXTURES[k]!;
    ff(['-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${s.rate}:duration=${s.seconds}`, '-f', 'lavfi', '-i', `sine=frequency=${s.freq}:sample_rate=48000:duration=${s.seconds + 0.2}`,
      '-vf', `${STRIP},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', String(s.gop), '-bf', String(s.bframes), '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-t', String(s.seconds), '-movflags', '+faststart', out[k]!]);
  }
  if (need('D')) ff(['-f', 'lavfi', '-i', `sine=frequency=${FIXTURES.D!.freq}:sample_rate=44100:duration=5`, '-ac', '1', '-c:a', 'pcm_s16le', out.D!]);
  if (need('E')) ff(['-display_rotation', '90', '-i', out.A!, '-c', 'copy', out.E!]);
  if (need('G')) ff(['-i', out.A!, '-c', 'copy', '-output_ts_offset', '3.5', out.G!]);
  if (need('F')) { const b = fs.readFileSync(out.A!); fs.writeFileSync(out.F!, b.subarray(0, Math.floor(b.length * 0.3))); }
  if (!fs.existsSync(out.Z!)) fs.writeFileSync(out.Z!, '');
  return out;
}
