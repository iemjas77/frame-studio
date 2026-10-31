import { Rate } from './rational.ts';

/**
 * Timecode display. Drop-frame changes frame *numbering* only (it skips labels, never frames)
 * and never changes playback speed. Defined only for 30000/1001 (drop 2) and 60000/1001 (drop 4).
 */
export interface TimecodeFormat { readonly rate: Rate; readonly dropFrame: boolean }

export const nominalFps = (r: Rate): number => Math.round(r.num / r.den);

export const dropFramesPerMinute = (r: Rate): number => {
  if (r.num === 30000 && r.den === 1001) return 2;
  if (r.num === 60000 && r.den === 1001) return 4;
  return 0;
};

export const supportsDropFrame = (r: Rate): boolean => dropFramesPerMinute(r) > 0;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Frame number (0-based count of real frames) -> timecode string. Negative values get a leading '-'. */
export function framesToTimecode(frame: number, fmt: TimecodeFormat): string {
  if (!Number.isSafeInteger(frame)) throw new RangeError('frame must be a safe integer');
  const neg = frame < 0; let f = Math.abs(frame);
  const fps = nominalFps(fmt.rate);
  const sep = fmt.dropFrame ? ';' : ':';
  if (fmt.dropFrame) {
    const drop = dropFramesPerMinute(fmt.rate);
    if (!drop) throw new RangeError('drop-frame is only defined for 29.97 and 59.94');
    const perMin = fps * 60 - drop;            // frames in a "dropping" minute
    const per10 = fps * 600 - drop * 9;        // frames in 10 minutes
    const tenMin = Math.floor(f / per10), rem = f % per10;
    // first minute of each 10-minute block drops nothing
    f += drop * 9 * tenMin + (rem > drop ? drop * Math.floor((rem - drop) / perMin) : 0);
  }
  const ff = f % fps, ss = Math.floor(f / fps) % 60, mm = Math.floor(f / (fps * 60)) % 60, hh = Math.floor(f / (fps * 3600));
  return `${neg ? '-' : ''}${pad(hh)}:${pad(mm)}:${pad(ss)}${sep}${pad(ff, fps >= 100 ? 3 : 2)}`;
}

const TC_RE = /^(-?)(\d{1,3}):(\d{2}):(\d{2})([:;])(\d{2,3})$/;

/** Timecode string -> frame number. Rejects labels that do not exist in drop-frame (e.g. 00:01:00;00). */
export function timecodeToFrames(tc: string, fmt: TimecodeFormat): number {
  const m = TC_RE.exec(tc.trim());
  if (!m) throw new SyntaxError(`invalid timecode "${tc}"`);
  const [, sign, h, mi, s, sep, fr] = m; const fps = nominalFps(fmt.rate);
  const hh = +h!, mm = +mi!, ss = +s!, ff = +fr!;
  if (mm > 59 || ss > 59 || ff >= fps) throw new RangeError(`timecode field out of range: ${tc}`);
  if ((sep === ';') !== fmt.dropFrame) throw new SyntaxError(`separator "${sep}" does not match ${fmt.dropFrame ? 'drop' : 'non-drop'}-frame format`);
  let frames = ((hh * 60 + mm) * 60 + ss) * fps + ff;
  if (fmt.dropFrame) {
    const drop = dropFramesPerMinute(fmt.rate);
    if (!drop) throw new RangeError('drop-frame is only defined for 29.97 and 59.94');
    if (ss === 0 && ff < drop && mm % 10 !== 0) throw new RangeError(`timecode ${tc} does not exist in drop-frame`);
    const totalMinutes = hh * 60 + mm;
    frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return sign ? -frames : frames;
}
