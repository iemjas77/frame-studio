import type { Rate } from '@fs/timeline-model';

export type TransportState = 'stopped' | 'paused' | 'playing';
export interface TransportOptions { rate: Rate; /** length in frames; playback stops (or loops) here */ duration: () => number; now: () => number; loop?: () => { start: number; end: number } | null }

/**
 * Transport for one monitor. Position is derived from a (frame, time) anchor on every read: no accumulated per-tick error.
 * Without an audio device the monotonic clock is the master clock; with audio the audio engine will re-anchor via `syncTo`.
 * Every seek / start / direction change bumps `generation`; frames produced for an older generation must be discarded.
 */
export class Transport {
  state: TransportState = 'paused'; speed = 1; direction: 1 | -1 = 1; generation = 0;
  private anchorFrame = 0; private anchorMs = 0; private lastPresented = -1; private presentedCount = 0; dropped = 0;
  constructor(private o: TransportOptions) { this.anchorMs = o.now(); }
  private rawFrame(): number {
    if (this.state !== 'playing') return this.anchorFrame;
    const dtMs = this.o.now() - this.anchorMs;
    return this.anchorFrame + this.direction * Math.floor((dtMs * this.speed * this.o.rate.num) / (this.o.rate.den * 1000));
  }
  /** Current frame; handles end-of-sequence (stop at last frame, or wrap when looping). */
  position(): number {
    const raw = this.rawFrame(); const d = this.o.duration(); const lp = this.o.loop?.() ?? null;
    if (this.state === 'playing') {
      const lo = lp?.start ?? 0, hi = lp ? lp.end : d; // hi exclusive
      if (this.direction === 1 && raw >= hi) { if (lp) { this.reanchor(lo + ((raw - lo) % Math.max(1, hi - lo))); return this.anchorFrame; } this.state = 'paused'; this.anchorFrame = Math.max(0, d - 1); this.generation++; return this.anchorFrame; }
      if (this.direction === -1 && raw < lo) { if (lp) { this.reanchor(hi - 1); return this.anchorFrame; } this.state = 'paused'; this.anchorFrame = 0; this.generation++; return 0; }
    }
    return Math.min(Math.max(0, raw), Math.max(0, d - 1));
  }
  private reanchor(frame: number) { this.anchorFrame = frame; this.anchorMs = this.o.now(); }
  /** Seek. Returns the new generation; only frames tagged with it may be displayed. */
  seek(frame: number): number { this.generation++; this.reanchor(Math.min(Math.max(0, Math.trunc(frame)), Math.max(0, this.o.duration() - 1))); this.lastPresented = -1; return this.generation; }
  step(n: number): number { this.pause(); return this.seek(this.position() + n); }
  play(dir: 1 | -1 = 1, speed = 1): void { const p = this.position(); this.state = 'playing'; this.direction = dir; this.speed = speed; this.generation++; this.reanchor(p); this.lastPresented = -1; }
  pause(): void { if (this.state === 'playing') { const p = this.position(); this.state = 'paused'; this.anchorFrame = p; this.generation++; } else this.state = this.state === 'stopped' ? 'stopped' : 'paused'; }
  stop(): void { this.state = 'stopped'; this.generation++; this.reanchor(0); }
  /** J/K/L shuttle: L faster forward (1,2,4,8x), J faster reverse, K pause. */
  shuttle(key: 'J' | 'K' | 'L'): void {
    if (key === 'K') return this.pause();
    const dir: 1 | -1 = key === 'L' ? 1 : -1;
    if (this.state !== 'playing' || this.direction !== dir) return this.play(dir, 1);
    const p = this.position(); this.speed = Math.min(8, this.speed * 2); this.generation++; this.reanchor(p);
  }
  /** Audio engine hook: re-anchor to the audio clock position. */
  syncTo(frame: number): void { if (this.state === 'playing') this.reanchor(frame); }
  /** Display gate: true only if the frame belongs to the latest generation. Also counts dropped frames during playback. */
  present(gen: number, frame: number): boolean {
    if (gen !== this.generation) return false;
    if (this.state === 'playing' && this.lastPresented >= 0) { const gap = (frame - this.lastPresented) * this.direction - 1; if (gap > 0) this.dropped += gap; }
    this.lastPresented = frame; this.presentedCount++; return true;
  }
  get presented(): number { return this.presentedCount; }
}
