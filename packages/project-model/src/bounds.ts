import { Frac, Rate, seconds, sourceSpan } from '@fs/timeline-model';
import type { Clip, MediaRef, Sequence } from './types.ts';

/** Source time range [lo, hi) in seconds that a clip references. */
export function clipSourceRange(c: Clip, seqRate: Rate): { lo: Frac; hi: Frac } {
  const a = seconds(c.sourceIn); const span = sourceSpan(c.duration, c.speed, seqRate);
  return c.speed.num >= 0 ? { lo: a, hi: a.add(span) } : { lo: a.sub(span), hi: a };
}

/** Length of the media stream a clip uses, in seconds, or null if the media lacks that stream. */
export function streamDuration(m: MediaRef, stream: 'video' | 'audio'): Frac | null {
  const info = stream === 'video' ? m.video : m.audio;
  return info ? seconds(info.duration) : null;
}

/** One source tick of tolerance absorbs rounding of cross-domain conversion. */
export function sourceTolerance(m: MediaRef, stream: 'video' | 'audio'): Frac {
  const info = stream === 'video' ? m.video : m.audio;
  if (!info) return Frac.of(0);
  const r = info.duration.rate; return Frac.of(r.den, r.num);
}

export function clipWithinSource(c: Clip, seq: Sequence, m: MediaRef): boolean {
  const total = streamDuration(m, c.stream); if (!total) return false;
  const { lo, hi } = clipSourceRange(c, seq.rate); const tol = sourceTolerance(m, c.stream);
  return lo.add(tol).cmp(Frac.of(0)) >= 0 && hi.cmp(total.add(tol)) <= 0;
}

/** A/V sync offset: sequence seconds minus source seconds at the clip start. Linked clips must agree (within one audio sample). */
export function syncOffset(c: Clip, seqRate: Rate): Frac {
  return Frac.of(c.start).div(Frac.of(seqRate.num, seqRate.den)).sub(seconds(c.sourceIn).div(c.speed.num >= 0 ? Frac.of(c.speed.num, c.speed.den) : Frac.of(-c.speed.num, c.speed.den)));
}
