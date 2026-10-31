import { Frac, Rate, Rounding, rate, rateFrac, toSafeInt } from './rational.ts';

/**
 * A point or duration in one explicit time domain: `ticks` at `rate` ticks/second.
 * The domain (rate) is part of the value so mixing domains is impossible by accident.
 * Video: rate = frame rate (one tick = one frame). Audio: rate = sample rate.
 */
export interface Time { readonly ticks: number; readonly rate: Rate }

export const time = (ticks: number, r: Rate): Time => {
  if (!Number.isSafeInteger(ticks)) throw new RangeError('time ticks must be a safe integer');
  return { ticks, rate: r };
};

/** Exact seconds as a fraction. */
export const seconds = (t: Time): Frac => Frac.of(t.ticks).div(rateFrac(t.rate));

/** Convert between domains with an explicit rounding rule (no implicit rounding anywhere). */
export const convert = (t: Time, to: Rate, mode: Rounding): Time =>
  time(toSafeInt(seconds(t).mul(rateFrac(to)).round(mode), 'converted time'), to);

export const compareTime = (a: Time, b: Time): -1 | 0 | 1 => seconds(a).cmp(seconds(b));
export const addTime = (a: Time, b: Time, mode: Rounding = 'nearest'): Time =>
  (a.rate.num === b.rate.num && a.rate.den === b.rate.den)
    ? time(a.ticks + b.ticks, a.rate)
    : time(toSafeInt(seconds(a).add(seconds(b)).mul(rateFrac(a.rate)).round(mode)), a.rate);

/** Integer frame count of a duration given in seconds (Frac): explicit rounding. */
export const secondsToTicks = (s: Frac, r: Rate, mode: Rounding): number =>
  toSafeInt(s.mul(rateFrac(r)).round(mode), 'ticks');

export { rate };
