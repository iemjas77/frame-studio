/** Half-open integer interval [start, end) in one time domain. Adjacent intervals do not overlap. */
export interface Interval { readonly start: number; readonly end: number }

export const interval = (start: number, end: number): Interval => {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) throw new RangeError(`invalid interval [${start}, ${end})`);
  return { start, end };
};
export const length = (i: Interval): number => i.end - i.start;
export const isEmpty = (i: Interval): boolean => i.end <= i.start;
export const contains = (i: Interval, t: number): boolean => t >= i.start && t < i.end;
export const overlaps = (a: Interval, b: Interval): boolean => a.start < b.end && b.start < a.end && !isEmpty(a) && !isEmpty(b);
export const intersect = (a: Interval, b: Interval): Interval | null =>
  overlaps(a, b) ? { start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) } : null;
/** a minus b: 0, 1 or 2 intervals. */
export const subtract = (a: Interval, b: Interval): Interval[] => {
  if (!overlaps(a, b)) return [a];
  const out: Interval[] = [];
  if (a.start < b.start) out.push({ start: a.start, end: b.start });
  if (b.end < a.end) out.push({ start: b.end, end: a.end });
  return out;
};
