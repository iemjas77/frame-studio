import { Frac, Rate, Rounding, rateFrac, toSafeInt } from './rational.ts';
import { Time, seconds, time } from './time.ts';

/**
 * Source <-> sequence mapping.
 *
 * Sequence time is integer frames at the sequence rate. Source time is an explicit `Time`
 * in the media's domain. `speed` is a signed exact fraction: source seconds consumed per
 * sequence second (1 = normal, 1/2 = half speed, -1 = reverse, 0 is not a valid speed:
 * freeze frames are represented by a dedicated hold, never speed 0).
 *
 * A displayed video frame k of a clip covers sequence interval [k, k+1). Its source frame is the
 * one containing the *centre* of that interval after mapping ("centre sampling"). At speed 1
 * and identical rates this is exactly sourceIn + (k - start); across rates it minimises error
 * and is symmetric for reverse playback.
 */
export interface Speed { readonly num: number; readonly den: number }
export const NORMAL_SPEED: Speed = { num: 1, den: 1 };
export const speedFrac = (s: Speed): Frac => {
  if (s.num === 0 || s.den <= 0 || !Number.isSafeInteger(s.num) || !Number.isSafeInteger(s.den)) throw new RangeError('invalid speed');
  return Frac.of(s.num, s.den);
};

export interface MapParams {
  /** clip start on the sequence, in sequence frames */
  readonly start: number;
  /** source position corresponding to the clip's first sequence instant */
  readonly sourceIn: Time;
  readonly speed: Speed;
  readonly seqRate: Rate;
}

/** Exact source instant (seconds) for a sequence instant given in exact frames (may be fractional). */
export function sourceSecondsAt(p: MapParams, seqFrames: Frac): Frac {
  const dt = seqFrames.sub(Frac.of(p.start)).div(rateFrac(p.seqRate)); // sequence seconds since clip start
  return seconds(p.sourceIn).add(dt.mul(speedFrac(p.speed)));
}

/** Source video frame index (in the media's frame domain) shown at sequence frame k. */
export function sourceVideoFrameAt(p: MapParams, k: number, mediaRate: Rate): number {
  const centre = Frac.of(2 * k + 1, 2);
  return toSafeInt(sourceSecondsAt(p, centre).mul(rateFrac(mediaRate)).floor(), 'source frame');
}

/**
 * Source sample position at a sequence frame *boundary* (nearest sample). Sample ranges for a clip are
 * computed as sample(b) - sample(a) from independent boundaries, so there is no accumulated drift.
 */
export function sourceSampleAtBoundary(p: MapParams, boundary: number, sampleRate: Rate, mode: Rounding = 'nearest'): number {
  return toSafeInt(sourceSecondsAt(p, Frac.of(boundary)).mul(rateFrac(sampleRate)).round(mode), 'source sample');
}

/** Source seconds consumed by `durationFrames` sequence frames (absolute value). */
export function sourceSpan(durationFrames: number, speed: Speed, seqRate: Rate): Frac {
  const s = Frac.of(durationFrames).div(rateFrac(seqRate)).mul(speedFrac(speed));
  return s.n < 0n ? s.neg() : s;
}

/**
 * Largest whole number of sequence frames that fit in `availableSourceSeconds` at `speed`.
 * Floors so a clip never references media beyond its end.
 */
export function maxSequenceFrames(availableSourceSeconds: Frac, speed: Speed, seqRate: Rate): number {
  const abs = speedFrac(speed); const a = abs.n < 0n ? abs.neg() : abs;
  return toSafeInt(availableSourceSeconds.div(a).mul(rateFrac(seqRate)).floor(), 'frames');
}

/** Proxy <-> source: proxies share the source's timeline; frames are re-expressed via seconds with explicit rounding. */
export function proxyToSource(t: Time, sourceRate: Rate, mode: Rounding = 'nearest'): Time {
  return time(toSafeInt(seconds(t).mul(rateFrac(sourceRate)).round(mode)), sourceRate);
}

/** Source time -> sequence frame of the clip (exact fraction of a frame; caller chooses rounding). */
export function sequenceFramesAtSource(p: MapParams, sourceSec: Frac): Frac {
  const dtSource = sourceSec.sub(seconds(p.sourceIn));
  return Frac.of(p.start).add(dtSource.div(speedFrac(p.speed)).mul(rateFrac(p.seqRate)));
}
