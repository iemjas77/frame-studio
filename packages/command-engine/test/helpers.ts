import { FPS, time, rate, seconds, Frac } from '@fs/timeline-model';
import { makeProject, makeSequence, syncOffset, validateProject, type MediaRef, type ProjectDoc, type Sequence } from '@fs/project-model';
import { CommandEngine, type Command } from '../src/index.ts';

export const media = (id: string, frames = 250, fr = FPS.f25, withAudio = true, audioSec?: number): MediaRef => ({
  id, name: `${id}.mp4`, binId: null, path: { absolute: `/media/${id}.mp4` }, fingerprint: { size: 1, headHash: id, tailHash: id },
  video: { codec: 'h264', width: 1920, height: 1080, rate: fr, duration: time(frames, fr), rotation: 0, par: { num: 1, den: 1 }, colour: {} },
  ...(withAudio ? { audio: { codec: 'aac', sampleRate: 48000, channels: 2, duration: time(Math.round((audioSec ?? (frames * fr.den) / fr.num) * 48000), rate(48000)) } } : {}), metadata: {},
});
export function setup(opts: { rate?: typeof FPS.f25; seqId?: string; idSeed?: string } = {}) {
  let n = 0;
  const p = makeProject('p1', 'T', '2026-01-01T00:00:00.000Z');
  const e = new CommandEngine(p, { idSource: () => `tx${String(++n).padStart(6, '0')}` });
  e.execute({ type: 'media.add', media: media('A') }); e.execute({ type: 'media.add', media: media('B', 100) });
  e.execute({ type: 'sequence.create', sequence: makeSequence({ id: 's1', name: 'S', rate: opts.rate ?? FPS.f25, videoTracks: 2, audioTracks: 2 }) });
  return { e, seq: () => e.state.sequences.s1!, get: (id: string) => find(e.state.sequences.s1!, id) };
}
export const find = (s: Sequence, id: string) => { for (const t of [...s.videoTracks, ...s.audioTracks]) for (const c of t.clips) if (c.id === id) return c; throw new Error(`no clip ${id}`); };
export const clips = (s: Sequence) => [...s.videoTracks, ...s.audioTracks].flatMap((t) => t.clips.map((c) => ({ t: t.name, id: c.id, s: c.start, e: c.start + c.duration, m: c.mediaId, in: c.sourceIn.ticks, stream: c.stream })));
export const ins = (e: CommandEngine, mediaId: string, time_: number, extra: Partial<Extract<Command, { type: 'edit.insert' }>> = {}) =>
  e.execute({ type: 'edit.insert', sequenceId: 's1', mediaId, time: time_, ...extra });
export const ovw = (e: CommandEngine, mediaId: string, time_: number, extra: Partial<Extract<Command, { type: 'edit.overwrite' }>> = {}) =>
  e.execute({ type: 'edit.overwrite', sequenceId: 's1', mediaId, time: time_, ...extra });
export function assertSynced(s: Sequence) {
  const groups = new Map<string, Frac[]>();
  for (const t of [...s.videoTracks, ...s.audioTracks]) for (const c of t.clips) if (c.linkGroupId) groups.set(c.linkGroupId, [...(groups.get(c.linkGroupId) ?? []), syncOffset(c, s.rate)]);
  for (const [g, offs] of groups) for (const o of offs) { const d = o.sub(offs[0]!); const tol = Frac.of(1, 48000); if ((d.n < 0n ? d.neg() : d).cmp(tol) > 0) throw new Error(`link group ${g} out of sync by ${d.toNumber()} s`); }
}
export function assertValid(p: ProjectDoc) { const errs = validateProject(p).filter((i) => i.severity === 'error'); if (errs.length) throw new Error(JSON.stringify(errs.slice(0, 3))); }
void seconds;
