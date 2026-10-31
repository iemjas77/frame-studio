import { spawn, ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { Frac, Rate, rateFrac } from '@fs/timeline-model';
import { MediaError } from '@fs/media-contracts';
import { runBounded } from './probe.ts';

/** Seek time (seconds, decimal) for source frame k: a quarter frame early so accurate-seek returns exactly frame k regardless of container pts rounding. */
export function seekSeconds(frame: number, r: Rate): string {
  const t = Frac.of(4 * frame - 1, 4).div(rateFrac(r)); const v = t.n < 0n ? 0 : t.toNumber(); return v.toFixed(6);
}
const vf = (w: number) => `scale=${w}:-2:flags=bilinear`;

/** One-shot decode of a single frame to JPEG (reference path: one short process per call; used for thumbnails and cold seeks). */
export async function decodeFrameJpeg(file: string, frame: number, r: Rate, width = 640, signal?: AbortSignal): Promise<Buffer> {
  const { stdout } = await runBounded('ffmpeg', ['-v', 'error', '-nostdin', '-ss', seekSeconds(frame, r), '-i', file, '-frames:v', '1', '-vf', vf(width), '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1'], { timeoutMs: 20_000, maxOutputBytes: 8 * 1024 * 1024 }, signal);
  if (stdout.length < 100) throw new MediaError('Unreadable', `no frame decoded at ${frame} (past end of media?)`);
  return stdout;
}
/** Raw decode helper for tests/validation: returns 8-bit gray pixels of one frame at native size scaled to w x h. */
export async function decodeFrameGray(file: string, frame: number, r: Rate, w: number, h: number): Promise<Buffer> {
  const { stdout } = await runBounded('ffmpeg', ['-v', 'error', '-nostdin', '-ss', seekSeconds(frame, r), '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=neighbor,format=gray`, '-f', 'rawvideo', 'pipe:1'], { timeoutMs: 20_000, maxOutputBytes: w * h + 1024 });
  if (stdout.length < w * h) throw new MediaError('Unreadable', `no frame decoded at ${frame}`);
  return stdout.subarray(0, w * h);
}
/** Read the 16-bit frame-number strip written by the fixture generator. */
export function readFrameStrip(gray: Buffer, w: number): number {
  let n = 0; const cell = w / 16;
  for (let b = 0; b < 16; b++) { const x = Math.floor(cell * b + cell / 2); const y = 2; if ((gray[y * w + x] ?? 0) > 128) n |= 1 << b; }
  return n;
}

/**
 * Sequential decoder: ONE long-lived ffmpeg process per (file, start) streaming MJPEG frames; get(k) for increasing k reuses it.
 * Random seeks restart the process (a seek, not a per-frame spawn). Bounded ring buffer; abortable; reference implementation
 * of the decode-service interface (the production path is a native decoder).
 */
export class SequentialFrameSource {
  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null; private next = 0; private ring = new Map<number, Buffer>(); private buf = Buffer.alloc(0);
  private waiters = new Map<number, ((b: Buffer | Error) => void)[]>(); private ended = false; private startedAt = -1; private stderr = ''; spawns = 0;
  constructor(readonly file: string, readonly rate: Rate, readonly width = 640, private ringSize = 24, private lookahead = 48) {}
  private start(frame: number) {
    this.kill(); this.spawns++; this.next = frame; this.startedAt = frame; this.ended = false; this.ring.clear(); this.buf = Buffer.alloc(0);
    const p = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-ss', seekSeconds(frame, this.rate), '-i', this.file, '-vf', vf(this.width), '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '5', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc = p; this.stderr = '';
    p.stderr.on('data', (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-2000); });
    p.stdout.on('data', (d: Buffer) => { if (this.proc !== p) return; this.buf = Buffer.concat([this.buf, d]); this.drain(p); });
    p.on('close', () => { if (this.proc !== p) return; this.ended = true; for (const [, ws] of this.waiters) ws.forEach((w) => w(new MediaError('Unreadable', `end of media before requested frame. ${this.stderr}`))); this.waiters.clear(); });
  }
  private drain(p: ChildProcessByStdio<null, Readable, Readable>) {
    for (;;) {
      const s = this.buf.indexOf(Buffer.from([0xff, 0xd8])); if (s < 0) { this.buf = Buffer.alloc(0); return; }
      const e = this.buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2); if (e < 0) { if (s > 0) this.buf = this.buf.subarray(s); return; }
      const frame = Buffer.from(this.buf.subarray(s, e + 2)); this.buf = this.buf.subarray(e + 2);
      const idx = this.next++; this.ring.set(idx, frame); if (this.ring.size > this.ringSize) this.ring.delete(Math.min(...this.ring.keys()));
      const ws = this.waiters.get(idx); if (ws) { ws.forEach((w) => w(frame)); this.waiters.delete(idx); }
      // backpressure: stop reading when far ahead of the consumer
      if (this.next - this.lastRequested > this.lookahead) { p.stdout.pause(); this.paused = true; }
    }
  }
  private paused = false; private lastRequested = 0;
  async get(frame: number, signal?: AbortSignal): Promise<Buffer> {
    this.lastRequested = frame; if (this.paused) { this.proc?.stdout.resume(); this.paused = false; }
    const hit = this.ring.get(frame); if (hit) return hit;
    const reachable = this.proc && !this.ended && frame >= this.next && frame - this.next <= this.lookahead && this.startedAt >= 0;
    if (!reachable) this.start(frame);
    return new Promise<Buffer>((resolve, reject) => {
      const t = setTimeout(() => done(new MediaError('Timeout', `decode of frame ${frame} timed out`)), 15_000);
      const done = (r: Buffer | Error) => { clearTimeout(t); signal?.removeEventListener('abort', onAbort); r instanceof Error ? reject(r) : resolve(r); };
      const onAbort = () => { const ws = this.waiters.get(frame); if (ws) this.waiters.set(frame, ws.filter((w) => w !== done)); done(new MediaError('Unreadable', 'aborted')); };
      if (signal?.aborted) return onAbort(); signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.set(frame, [...(this.waiters.get(frame) ?? []), done]);
      if (this.paused) { this.proc?.stdout.resume(); this.paused = false; }
    });
  }
  kill() { const p = this.proc; this.proc = null; if (p) { p.stdout.destroy(); p.kill('SIGKILL'); } }
}

/** Waveform peaks (0..1) for a media file; bounded by a decode cap. */
export async function waveformPeaks(file: string, buckets = 800, maxSeconds = 3600): Promise<{ peaks: number[]; durationSec: number }> {
  const sr = 8000; const { stdout } = await runBounded('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-t', String(maxSeconds), '-vn', '-ac', '1', '-ar', String(sr), '-f', 's16le', 'pipe:1'], { timeoutMs: 60_000, maxOutputBytes: maxSeconds * sr * 2 + 4096 });
  const n = Math.floor(stdout.length / 2); const per = Math.max(1, Math.ceil(n / buckets)); const peaks: number[] = [];
  for (let b = 0; b * per < n; b++) { let m = 0; for (let i = b * per; i < Math.min(n, (b + 1) * per); i++) m = Math.max(m, Math.abs(stdout.readInt16LE(i * 2))); peaks.push(m / 32768); }
  return { peaks, durationSec: n / sr };
}

/** Frame identity from the strip, or null when the picture body is black (no clip / gap). */
export function readFrameIdentity(gray: Buffer, w: number, h: number): number | null {
  let sum = 0, n = 0; for (let y = Math.floor(h * 0.4); y < Math.floor(h * 0.9); y += 4) for (let x = 0; x < w; x += 8) { sum += gray[y * w + x] ?? 0; n++; }
  if (sum / n < 6) return null; return readFrameStrip(gray, w);
}
