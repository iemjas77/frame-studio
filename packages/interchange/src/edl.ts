import { framesToTimecode, timecodeToFrames, supportsDropFrame, convert, time, seconds, rateFrac } from '@fs/timeline-model';
import type { ProjectDoc, Sequence } from '@fs/project-model';
import type { LossItem, LossReport } from './loss.ts';

/**
 * CMX3600-style EDL. Granularity is one sequence frame; every source position is rounded to a sequence-rate frame.
 * One event per clip, V tracks as `V`, A tracks as `A`; reel `AX` with the clip name in a `* FROM CLIP NAME` comment.
 */
export function exportEdl(doc: ProjectDoc, sequenceId: string): { edl: string; loss: LossReport } {
  const seq: Sequence = doc.sequences[sequenceId] ?? (() => { throw new Error('sequence not found'); })();
  const df = seq.dropFrame && supportsDropFrame(seq.rate); const f = { rate: seq.rate, dropFrame: df }; const loss: LossItem[] = [];
  const lines = [`TITLE: ${seq.name.replace(/[\r\n]/g, ' ')}`, `FCM: ${df ? 'DROP FRAME' : 'NON-DROP FRAME'}`, ''];
  let n = 1;
  for (const tracks of [seq.videoTracks, seq.audioTracks]) for (const t of tracks) for (const c of t.clips) {
    const si = convert(c.sourceIn, seq.rate, 'nearest').ticks; const exactBack = convert(time(si, seq.rate), c.sourceIn.rate, 'nearest');
    if (exactBack.ticks !== c.sourceIn.ticks) loss.push({ feature: 'source in precision', detail: `${c.name} source-in rounded to a ${seq.rate.num}/${seq.rate.den} frame boundary`, severity: 'approximated' });
    if (c.speed.num !== 1 || c.speed.den !== 1) loss.push({ feature: 'speed', detail: `${c.name}: no M2 speed comment written`, severity: 'lost' });
    const pad = (k: number) => String(k).padStart(3, '0');
    lines.push(`${pad(n++)}  AX       ${t.kind === 'video' ? 'V' : 'A'}     C        ${framesToTimecode(si, f)} ${framesToTimecode(si + c.duration, f)} ${framesToTimecode(seq.startFrame + c.start, f)} ${framesToTimecode(seq.startFrame + c.start + c.duration, f)}`);
    lines.push(`* FROM CLIP NAME: ${(doc.mediaPool[c.mediaId]?.name ?? c.name).replace(/[\r\n]/g, ' ')}`, '');
  }
  loss.push({ feature: 'track identity', detail: 'EDL events do not carry track numbers or names; V/A kind only', severity: 'lost' }, { feature: 'link groups, locks, gain, markers', detail: 'not representable', severity: 'lost' },
    { feature: 'media paths', detail: 'only the file name is written as a comment; relinking on import is by name and must be confirmed by the importer', severity: 'lost' });
  return { edl: lines.join('\n'), loss: { format: 'CMX3600 EDL', items: dedupe(loss) } };
}
const dedupe = (a: LossItem[]) => a.filter((x, i) => a.findIndex((y) => y.feature === x.feature && y.detail === x.detail) === i);

export interface EdlEvent { n: number; reel: string; kind: 'V' | 'A'; srcIn: number; srcOut: number; recIn: number; recOut: number; clipName?: string }
export function parseEdl(text: string, rate: { num: number; den: number }): { events: EdlEvent[]; dropFrame: boolean; warnings: string[] } {
  const warnings: string[] = []; let dropFrame = false; const events: EdlEvent[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim(); if (!l) continue;
    if (/^FCM:\s*DROP/i.test(l)) { dropFrame = true; continue; } if (/^(TITLE|FCM):/i.test(l)) continue;
    const c = /^\*\s*FROM CLIP NAME:\s*(.*)$/i.exec(l); if (c) { if (events.length) events[events.length - 1]!.clipName = c[1]; continue; }
    const m = /^(\d{3,6})\s+(\S+)\s+(V|A|AA|B|VA)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/.exec(l);
    if (!m) { warnings.push(`ignored line: ${l.slice(0, 60)}`); continue; }
    if (m[4] !== 'C') { warnings.push(`event ${m[1]}: transition/edit type "${m[4]}" not supported, ignored`); continue; }
    const fmt = { rate: rate as never, dropFrame };
    events.push({ n: +m[1]!, reel: m[2]!, kind: m[3] === 'V' ? 'V' : 'A', srcIn: timecodeToFrames(m[5]!, fmt), srcOut: timecodeToFrames(m[6]!, fmt), recIn: timecodeToFrames(m[7]!, fmt), recOut: timecodeToFrames(m[8]!, fmt) });
  }
  return { events, dropFrame, warnings };
}
void seconds; void rateFrac;
