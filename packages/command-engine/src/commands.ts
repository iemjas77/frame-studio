import type { Time } from '@fs/timeline-model';
import { Bin, Id, Interpretation, Marker, MediaRef, PathRef, Fingerprint, ProjectDoc, ProxyRef, Sequence, Track } from '@fs/project-model';
import { validateProject, hasErrors, makeTrack } from '@fs/project-model';
import { Ctx } from './ctx.ts';
import { CommandError, fail } from './errors.ts';
import * as E from './edit.ts';

/** Serializable, versioned semantic operations. Panels never mutate project state; they submit these. */
export type Command =
  | { type: 'media.add'; media: MediaRef }
  | { type: 'media.update'; mediaId: Id; patch: { name?: string; binId?: Id | null; path?: PathRef; fingerprint?: Fingerprint; interpretation?: Interpretation | null; proxy?: ProxyRef | null; metadata?: Record<string, string> } }
  | { type: 'media.remove'; mediaId: Id }
  | { type: 'bin.create'; bin: Bin }
  | { type: 'sequence.create'; sequence: Sequence; activate?: boolean }
  | { type: 'sequence.activate'; sequenceId: Id }
  | { type: 'sequence.setRange'; sequenceId: Id; inPoint: number | null; outPoint: number | null }
  | { type: 'track.add'; sequenceId: Id; kind: 'video' | 'audio'; name?: string }
  | { type: 'track.set'; sequenceId: Id; trackId: Id; patch: Partial<Pick<Track, 'name' | 'locked' | 'muted' | 'solo' | 'visible' | 'syncLock' | 'targeted' | 'height'>> }
  | { type: 'edit.insert'; sequenceId: Id; mediaId: Id; time: number; sourceIn?: Time; sourceOut?: Time; targets?: { video?: Id; audio?: Id }; only?: 'both' | 'video' | 'audio' }
  | { type: 'edit.overwrite'; sequenceId: Id; mediaId: Id; time: number; sourceIn?: Time; sourceOut?: Time; targets?: { video?: Id; audio?: Id }; only?: 'both' | 'video' | 'audio' }
  | { type: 'edit.append'; sequenceId: Id; mediaId: Id; sourceIn?: Time; sourceOut?: Time; targets?: { video?: Id; audio?: Id }; only?: 'both' | 'video' | 'audio' }
  | { type: 'edit.split'; sequenceId: Id; time: number; clipIds?: Id[]; allTracks?: boolean; ignoreLinks?: boolean }
  | { type: 'edit.lift'; sequenceId: Id; clipIds: Id[]; ignoreLinks?: boolean }
  | { type: 'edit.rippleDelete'; sequenceId: Id; clipIds: Id[]; ignoreLinks?: boolean; allowPartial?: boolean }
  | { type: 'edit.removeGap'; sequenceId: Id; trackId: Id; time: number; allowPartial?: boolean }
  | { type: 'edit.move'; sequenceId: Id; clipIds: Id[]; deltaFrames: number; trackDelta?: { video?: number; audio?: number }; mode?: 'strict' | 'overwrite'; ignoreLinks?: boolean }
  | { type: 'edit.trim'; sequenceId: Id; clipId: Id; edge: 'start' | 'end'; toTime: number; ripple?: boolean; ignoreLinks?: boolean; allowPartial?: boolean }
  | { type: 'edit.slip'; sequenceId: Id; clipId: Id; deltaFrames: number; ignoreLinks?: boolean }
  | { type: 'edit.rolling'; sequenceId: Id; leftClipId: Id; delta: number; ignoreLinks?: boolean }
  | { type: 'edit.slide'; sequenceId: Id; clipId: Id; delta: number; ignoreLinks?: boolean }
  | { type: 'edit.link'; sequenceId: Id; clipIds: Id[] }
  | { type: 'edit.unlink'; sequenceId: Id; clipIds: Id[] }
  | { type: 'marker.add'; sequenceId: Id; marker: Omit<Marker, 'id'> & { id?: Id } }
  | { type: 'marker.remove'; sequenceId: Id; markerId: Id }
  | { type: 'marker.move'; sequenceId: Id; markerId: Id; time: number }
  /** Several commands as ONE atomic transaction / one history entry (used by macros). Nested batches are refused. */
  | { type: 'batch'; commands: Command[] };

export const COMMAND_TYPES = ['media.add', 'media.update', 'media.remove', 'bin.create', 'sequence.create', 'sequence.activate', 'sequence.setRange', 'track.add', 'track.set',
  'edit.insert', 'edit.overwrite', 'edit.append', 'edit.split', 'edit.lift', 'edit.rippleDelete', 'edit.removeGap', 'edit.move', 'edit.trim', 'edit.slip', 'edit.rolling', 'edit.slide', 'edit.link', 'edit.unlink',
  'marker.add', 'marker.remove', 'marker.move', 'batch'] as const;

const seqOf = (p: ProjectDoc, id: Id): Sequence => p.sequences[id] ?? fail('NotFound', `sequence ${id} not found`);

/** Apply a command to a mutable (draft) project. Throws CommandError; caller discards the draft on failure. */
export function applyCommand(p: ProjectDoc, cmd: Command, ctx: Ctx): void {
  if (!cmd || !(COMMAND_TYPES as readonly string[]).includes(cmd.type)) fail('InvalidArgument', `unknown command type ${(cmd as { type?: string })?.type}`);
  const ed = (sequenceId: Id): E.Edit => ({ seq: seqOf(p, sequenceId), ctx, media: (id) => p.mediaPool[id] ?? fail('NotFound', `media ${id} not found`) });
  switch (cmd.type) {
    case 'batch':
      if (!Array.isArray(cmd.commands) || cmd.commands.length === 0 || cmd.commands.length > 1000) fail('InvalidArgument', 'batch needs 1..1000 commands');
      for (const c of cmd.commands) { if (c?.type === 'batch') fail('InvalidArgument', 'nested batch is not allowed'); applyCommand(p, c, ctx); }
      return;
    case 'media.add':
      if (p.mediaPool[cmd.media.id]) fail('InvalidArgument', `media ${cmd.media.id} already exists`);
      p.mediaPool[cmd.media.id] = cmd.media; p.mediaOrder.push(cmd.media.id); return;
    case 'media.update': {
      const m = p.mediaPool[cmd.mediaId] ?? fail('NotFound', `media ${cmd.mediaId} not found`); const pt = cmd.patch;
      if (pt.name !== undefined) m.name = pt.name; if (pt.binId !== undefined) m.binId = pt.binId; if (pt.path) m.path = pt.path; if (pt.fingerprint) m.fingerprint = pt.fingerprint;
      if (pt.interpretation !== undefined) { if (pt.interpretation === null) delete m.interpretation; else m.interpretation = pt.interpretation; }
      if (pt.proxy !== undefined) { if (pt.proxy === null) delete m.proxy; else m.proxy = pt.proxy; }
      if (pt.metadata) m.metadata = { ...m.metadata, ...pt.metadata }; return;
    }
    case 'media.remove': {
      for (const s of Object.values(p.sequences)) for (const t of [...s.videoTracks, ...s.audioTracks]) if (t.clips.some((c) => c.mediaId === cmd.mediaId)) fail('MediaInUse', `media ${cmd.mediaId} is used in sequence ${s.name}`);
      if (!p.mediaPool[cmd.mediaId]) fail('NotFound', `media ${cmd.mediaId} not found`);
      delete p.mediaPool[cmd.mediaId]; p.mediaOrder = p.mediaOrder.filter((i) => i !== cmd.mediaId); return;
    }
    case 'bin.create': if (p.bins[cmd.bin.id]) fail('InvalidArgument', 'bin exists'); p.bins[cmd.bin.id] = cmd.bin; p.binOrder.push(cmd.bin.id); return;
    case 'sequence.create':
      if (p.sequences[cmd.sequence.id]) fail('InvalidArgument', 'sequence exists');
      p.sequences[cmd.sequence.id] = cmd.sequence; p.sequenceOrder.push(cmd.sequence.id);
      if (cmd.activate !== false || !p.activeSequenceId) p.activeSequenceId = cmd.sequence.id; ctx.touch(cmd.sequence.id); return;
    case 'sequence.activate': seqOf(p, cmd.sequenceId); p.activeSequenceId = cmd.sequenceId; return;
    case 'sequence.setRange': { const s = seqOf(p, cmd.sequenceId); s.inPoint = cmd.inPoint; s.outPoint = cmd.outPoint; ctx.touch(s.id); return; }
    case 'track.add': {
      const s = seqOf(p, cmd.sequenceId); const list = cmd.kind === 'video' ? s.videoTracks : s.audioTracks;
      list.push(makeTrack(ctx.newId('track'), cmd.kind, cmd.name ?? `${cmd.kind === 'video' ? 'V' : 'A'}${list.length + 1}`)); ctx.touch(s.id); return;
    }
    case 'track.set': { const s = seqOf(p, cmd.sequenceId); Object.assign(E.findTrack(s, cmd.trackId), cmd.patch); ctx.touch(s.id); return; }
    case 'edit.insert': case 'edit.overwrite': case 'edit.append': {
      const e = ed(cmd.sequenceId); const only = cmd.only ?? 'both'; const sel = { in: cmd.sourceIn, out: cmd.sourceOut }; const tg = cmd.targets ?? {};
      if (cmd.type === 'edit.append') {
        const probe = E.buildClips(e, cmd.mediaId, 0, sel, tg, only); const t = E.appendTime(e, probe);
        probe.forEach((pl) => { pl.clip.start = t; }); E.overwriteClips(e, t, probe); return;
      }
      const places = E.buildClips(e, cmd.mediaId, cmd.time, sel, tg, only);
      (cmd.type === 'edit.insert' ? E.insertClips : E.overwriteClips)(e, cmd.time, places); return;
    }
    case 'edit.split': E.splitClips(ed(cmd.sequenceId), cmd.time, cmd); return;
    case 'edit.lift': E.liftClips(ed(cmd.sequenceId), cmd.clipIds, cmd.ignoreLinks); return;
    case 'edit.rippleDelete': E.rippleDeleteClips(ed(cmd.sequenceId), cmd.clipIds, cmd); return;
    case 'edit.removeGap': E.removeGap(ed(cmd.sequenceId), cmd.trackId, cmd.time, cmd.allowPartial); return;
    case 'edit.move': E.moveClips(ed(cmd.sequenceId), cmd); return;
    case 'edit.trim': E.trimClip(ed(cmd.sequenceId), cmd); return;
    case 'edit.slip': E.slipClips(ed(cmd.sequenceId), cmd.clipId, cmd.deltaFrames, cmd.ignoreLinks); return;
    case 'edit.rolling': E.rollingEdit(ed(cmd.sequenceId), cmd.leftClipId, cmd.delta, cmd.ignoreLinks); return;
    case 'edit.slide': E.slideClip(ed(cmd.sequenceId), cmd.clipId, cmd.delta, cmd.ignoreLinks); return;
    case 'edit.link': E.linkClips(ed(cmd.sequenceId), cmd.clipIds); return;
    case 'edit.unlink': E.unlinkClips(ed(cmd.sequenceId), cmd.clipIds); return;
    case 'marker.add': { const s = seqOf(p, cmd.sequenceId); s.markers.push({ ...cmd.marker, id: cmd.marker.id ?? ctx.newId('marker') }); s.markers.sort((a, b) => a.time - b.time); ctx.touch(s.id); return; }
    case 'marker.remove': { const s = seqOf(p, cmd.sequenceId); const i = s.markers.findIndex((m) => m.id === cmd.markerId); if (i < 0) fail('NotFound', 'marker not found'); s.markers.splice(i, 1); ctx.touch(s.id); return; }
    case 'marker.move': { const s = seqOf(p, cmd.sequenceId); const m = s.markers.find((x) => x.id === cmd.markerId) ?? fail('NotFound', 'marker not found'); m.time = cmd.time; s.markers.sort((a, b) => a.time - b.time); ctx.touch(s.id); return; }
  }
}

/** Post-condition: whole-project invariants must hold or the transaction is rolled back. */
export function assertInvariants(p: ProjectDoc): void {
  const issues = validateProject(p);
  if (hasErrors(issues)) throw new CommandError('Invariant', `command would violate project invariants: ${issues.filter((i) => i.severity === 'error').slice(0, 3).map((i) => `${i.code} @ ${i.path}`).join('; ')}`, issues);
}
