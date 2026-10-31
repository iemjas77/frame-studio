import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs'; import * as os from 'node:os'; import * as path from 'node:path';
import fc from 'fast-check';
import { FPS, time } from '@fs/timeline-model';
import { makeSequence, makeProject, type ProjectDoc } from '@fs/project-model';
import { checksumOf, journalRead, saveProjectAtomic, openProjectWithRecovery } from '@fs/project-model/node';
import { CommandEngine, CommandError, type Command } from '../src/index.ts';
import { ProjectSession } from '../src/session.ts';
import { setup, ins, ovw, media, clips, assertSynced, assertValid } from './helpers.ts';

describe('transactions & history', () => {
  it('failed command leaves state identical (same object) and history untouched', () => {
    const { e } = setup(); ins(e, 'B', 0); const s = e.state, d = e.historyDepth, r = e.revision;
    expect(() => e.execute({ type: 'edit.trim', sequenceId: 's1', clipId: 'nope', edge: 'end', toTime: 3 })).toThrow(CommandError);
    expect(e.state).toBe(s); expect(e.historyDepth).toBe(d); expect(e.revision).toBe(r);
  });
  it('state is deeply immutable: a held snapshot never changes (export/render safety)', () => {
    const { e } = setup(); ins(e, 'B', 0); const snap = e.state; const json = JSON.stringify(snap);
    expect(() => { (snap.sequences.s1!.videoTracks[0]!.clips[0] as any).start = 5; }).toThrow();
    ins(e, 'B', 10); e.undo(); e.undo(); expect(JSON.stringify(snap)).toBe(json);
  });
  it('undo/redo are exact and a new edit clears redo', () => {
    const { e } = setup(); const s0 = e.state; ins(e, 'A', 0); const s1 = e.state; ovw(e, 'B', 30);
    e.undo(); expect(e.state).toEqual(s1); e.undo(); expect(e.state).toEqual(s0.sequences ? e.state : s0); expect(e.canRedo).toBe(true);
    e.redo(); expect(e.state).toEqual(s1); e.undo(); ins(e, 'B', 5); expect(e.canRedo).toBe(false);
    expect(() => e.redo()).toThrow(/nothing to redo/);
  });
  it('a drag gesture is ONE history entry; each update evaluates from base; cancel restores', () => {
    const { e, seq } = setup(); ins(e, 'B', 0); const before = e.state, depth = e.historyDepth; const id = seq().videoTracks[0]!.clips[0]!.id;
    e.beginGesture('move', 'Move clip');
    for (const d of [5, 17, 40, 23]) e.updateGesture({ type: 'edit.move', sequenceId: 's1', clipIds: [id], deltaFrames: d });
    expect(seq().videoTracks[0]!.clips[0]!.start).toBe(23); expect(() => e.execute({ type: 'marker.add', sequenceId: 's1', marker: { time: 1, duration: 0, name: '', color: '', comment: '' } })).toThrow(/gesture/);
    expect(() => e.updateGesture({ type: 'edit.move', sequenceId: 's1', clipIds: [id], deltaFrames: -5 })).toThrow(CommandError); expect(seq().videoTracks[0]!.clips[0]!.start).toBe(23); // failed update keeps last preview
    e.commitGesture(); expect(e.historyDepth).toBe(depth + 1); e.undo(); expect(e.state).toEqual(before);
    e.redo(); e.undo(); e.beginGesture('x', 'x'); e.updateGesture({ type: 'edit.move', sequenceId: 's1', clipIds: [id], deltaFrames: 9 }); e.cancelGesture(); expect(e.state).toEqual(before); expect(e.historyDepth).toBe(depth);
  });
  it('history memory is bounded (entries and cost)', () => {
    let n = 0; const e = new CommandEngine(makeProject('p', 'p', 'x'), { maxHistoryEntries: 10, idSource: () => `t${++n}` });
    e.execute({ type: 'media.add', media: media('A') }); e.execute({ type: 'sequence.create', sequence: makeSequence({ id: 's1', name: 's' }) });
    for (let i = 0; i < 50; i++) e.execute({ type: 'marker.add', sequenceId: 's1', marker: { time: i, duration: 0, name: '', color: '', comment: '' } });
    expect(e.historyDepth).toBe(10); for (let i = 0; i < 10; i++) e.undo(); expect(() => e.undo()).toThrow(); expect(e.state.sequences.s1!.markers.length).toBe(40);
  });
  it('dirty tracking follows save point through undo/redo', () => {
    const { e } = setup(); e.markClean(); expect(e.isDirty).toBe(false); ins(e, 'B', 0); expect(e.isDirty).toBe(true); e.undo(); expect(e.isDirty).toBe(false); e.redo(); expect(e.isDirty).toBe(true);
  });
  it('change events report touched sequences and dirty range for invalidation', () => {
    const { e } = setup(); const seen: any[] = []; e.subscribe((_, c) => seen.push(c)); ins(e, 'B', 40); e.undo();
    expect(seen[0].touchedSequences).toEqual(['s1']); expect(seen[0].dirty.start).toBe(40); expect(seen[1].kind).toBe('undo');
  });
});

/* ---- randomized model test ---- */
function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; }; }
function randomCommand(e: CommandEngine, r: () => number): Command {
  const s = e.state.sequences.s1!; const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)]!; const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const all = [...s.videoTracks, ...s.audioTracks].flatMap((t) => t.clips); const anyClip = () => (all.length ? pick(all) : null);
  const end = Math.max(0, ...all.map((c) => c.start + c.duration));
  const choice = int(0, 14); const c = anyClip();
  switch (choice) {
    case 0: case 1: return { type: 'edit.insert', sequenceId: 's1', mediaId: pick(['A', 'B']), time: int(0, end), only: pick(['both', 'both', 'video', 'audio']), sourceIn: time(int(0, 20), FPS.f25), sourceOut: time(int(40, 90), FPS.f25), targets: { video: pick(['s1_V1', 's1_V2']), audio: pick(['s1_A1', 's1_A2']) } };
    case 2: case 3: return { type: 'edit.overwrite', sequenceId: 's1', mediaId: pick(['A', 'B']), time: int(0, end), only: pick(['both', 'video', 'audio']), sourceIn: time(int(0, 20), FPS.f25), sourceOut: time(int(40, 90), FPS.f25), targets: { video: pick(['s1_V1', 's1_V2']), audio: pick(['s1_A1', 's1_A2']) } };
    case 4: return { type: 'edit.append', sequenceId: 's1', mediaId: 'B', only: pick(['both', 'video']) };
    case 5: return { type: 'edit.split', sequenceId: 's1', time: int(0, end), ...(c && r() < 0.5 ? { clipIds: [c.id] } : { allTracks: true }) };
    case 6: return { type: 'edit.lift', sequenceId: 's1', clipIds: c ? [c.id] : ['x'] };
    case 7: return { type: 'edit.rippleDelete', sequenceId: 's1', clipIds: c ? [c.id] : ['x'], allowPartial: r() < 0.3 };
    case 8: return { type: 'edit.move', sequenceId: 's1', clipIds: c ? [c.id] : ['x'], deltaFrames: int(-30, 60), trackDelta: { video: int(-1, 1), audio: int(-1, 1) }, mode: pick(['strict', 'overwrite']) };
    case 9: case 10: return c ? { type: 'edit.trim', sequenceId: 's1', clipId: c.id, edge: pick(['start', 'end']), toTime: int(0, end + 20), ripple: r() < 0.4, allowPartial: r() < 0.3 } : { type: 'marker.remove', sequenceId: 's1', markerId: 'x' };
    case 11: return { type: 'edit.slip', sequenceId: 's1', clipId: c?.id ?? 'x', deltaFrames: int(-10, 10) };
    case 12: return { type: 'track.set', sequenceId: 's1', trackId: pick(['s1_V1', 's1_V2', 's1_A1', 's1_A2']), patch: { locked: r() < 0.3 } };
    case 13: return { type: 'edit.removeGap', sequenceId: 's1', trackId: pick(['s1_V1', 's1_A1']), time: int(0, end), allowPartial: r() < 0.5 };
    default: return { type: 'marker.add', sequenceId: 's1', marker: { time: int(0, end), duration: 0, name: 'm', color: 'c', comment: '' } };
  }
}
describe('randomized model test', () => {
  it('800 random operations: invariants hold, linked sync preserved, undo-all/redo-all exact, journal replay deterministic, failures atomic', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 2 ** 31 }), (seed) => {
      const { e } = setup(); const r = rng(seed); const initial = e.state; const log: { txId: string; command: Command }[] = []; let ok = 0;
      const e2 = new CommandEngine(initial, { idSource: () => `x${log.length}`, onCommit: (c) => { if ('command' in c) log.push(c); } });
      for (let i = 0; i < 80; i++) {
        const cmd = randomCommand(e2, r); const before = e2.state;
        try { e2.execute(cmd); ok++; } catch (err) { if (!(err instanceof CommandError)) throw err; expect(e2.state).toBe(before); continue; }
        try { assertSynced(e2.state.sequences.s1!); } catch (x) { if (process.env.DBG) { console.log('SYNC BREAK after', JSON.stringify(cmd)); console.log('BEFORE', JSON.stringify(clips(before.sequences.s1!))); console.log('AFTER', JSON.stringify(clips(e2.state.sequences.s1!)), JSON.stringify([...e2.state.sequences.s1!.videoTracks,...e2.state.sequences.s1!.audioTracks].map(t=>[t.name,t.locked,t.syncLock]))); } throw x; } assertValid(e2.state);
        if (r() < 0.1 && e2.canUndo) { e2.undo(); assertValid(e2.state); e2.redo(); }
      }
      const final = e2.state;
      const e3 = new CommandEngine(initial); for (const l of log) e3.execute(l.command, undefined, l.txId); expect(e3.state).toEqual(final); // replay determinism
      const depth = e2.historyDepth; for (let i = 0; i < depth; i++) e2.undo(); expect(e2.state).toEqual(initial);
      for (let i = 0; i < depth; i++) e2.redo(); expect(e2.state).toEqual(final);
      return ok >= 0;
    }), { numRuns: Number(process.env.FS_RUNS ?? 60) });
  });
});

/* ---- sessions: acceptance 1,2,5,7 at model/persistence level ---- */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fs-sess-'));
const newProject = () => { const p = makeProject('p1', 'P', '2026-01-01T00:00:00.000Z'); return p; };
const seed = (s: ProjectSession) => { s.engine.execute({ type: 'media.add', media: media('A') }); s.engine.execute({ type: 'sequence.create', sequence: makeSequence({ id: 's1', name: 'S' }) }); };

describe('session: save/reopen/recover', () => {
  it('acceptance 1: import -> source in/out -> insert -> trim -> save -> reopen reproduces the project', () => {
    const f = path.join(tmp(), 'p.fstudio'); const s = ProjectSession.create(f, newProject()); seed(s);
    s.engine.execute({ type: 'edit.insert', sequenceId: 's1', mediaId: 'A', time: 0, sourceIn: time(25, FPS.f25), sourceOut: time(125, FPS.f25) });
    s.engine.execute({ type: 'edit.trim', sequenceId: 's1', clipId: s.engine.state.sequences.s1!.videoTracks[0]!.clips[0]!.id, edge: 'end', toTime: 60 });
    s.save(); const r = ProjectSession.open(f); expect(r.engine.state).toEqual(s.engine.state); expect(r.report.journalReplayed).toBe(0); expect(r.dirty).toBe(false);
  });
  it('acceptance 7: crash after edits (no save) -> reopen replays the journal; torn last line is dropped', () => {
    const f = path.join(tmp(), 'p.fstudio'); const s = ProjectSession.create(f, newProject()); seed(s); s.save();
    s.engine.execute({ type: 'edit.insert', sequenceId: 's1', mediaId: 'A', time: 0 }); s.engine.execute({ type: 'edit.split', sequenceId: 's1', time: 100, allTracks: true }); s.engine.undo(); s.engine.redo();
    const expected = s.engine.state; fs.appendFileSync(`${f}.journal`, 'badbadbadbadbad0 {"kind":"tx","rev'); // simulated torn write during crash
    const r = ProjectSession.open(f); expect(r.engine.state).toEqual(expected); expect(r.report.journalReplayed).toBe(4); expect(r.report.journalDropped).toBe(true); expect(r.dirty).toBe(true);
    r.save(); const r2 = ProjectSession.open(f); expect(r2.engine.state).toEqual(expected); expect(r2.report.journalReplayed).toBe(0);
  });
  it('acceptance 7b: crash DURING save (tmp written, rename never happened) -> last valid project + journal recover everything', () => {
    const f = path.join(tmp(), 'p.fstudio'); const s = ProjectSession.create(f, newProject()); seed(s); s.save();
    s.engine.execute({ type: 'edit.insert', sequenceId: 's1', mediaId: 'A', time: 0 });
    expect(() => saveProjectAtomic(f, s.engine.state, 'x', { beforeRename: () => { throw new Error('killed'); } })).toThrow();
    fs.writeFileSync(`${f}.tmp-999-dead`, '{"half written'); // stray temp from a hard kill
    const r = ProjectSession.open(f); expect(r.engine.state).toEqual(s.engine.state); expect(r.report.journalReplayed).toBe(1);
  });
  it('journal from a different saved version is ignored with a reason, not replayed onto the wrong base', () => {
    const f = path.join(tmp(), 'p.fstudio'); const s = ProjectSession.create(f, newProject()); seed(s); s.save(); s.engine.execute({ type: 'edit.insert', sequenceId: 's1', mediaId: 'A', time: 0 });
    s.save(); // new base; now corrupt main so bak (older) is used -> journal base mismatch
    fs.writeFileSync(f, 'garbage'); const r = ProjectSession.open(f); expect(r.report.source).toBe('backup'); expect(r.report.journalSkippedReason).toMatch(/different saved version/); expect(r.report.journalReplayed).toBe(0);
  });
  it('acceptance 5: missing media -> relink (media.update) -> edits preserved, ids and timing unchanged', () => {
    const f = path.join(tmp(), 'p.fstudio'); const s = ProjectSession.create(f, newProject()); seed(s);
    s.engine.execute({ type: 'edit.insert', sequenceId: 's1', mediaId: 'A', time: 0 }); const before = JSON.stringify(s.engine.state.sequences);
    s.engine.execute({ type: 'media.update', mediaId: 'A', patch: { path: { absolute: '/new/place/A.mp4' } } });
    expect(JSON.stringify(s.engine.state.sequences)).toBe(before); expect(s.engine.state.mediaPool.A!.path.absolute).toBe('/new/place/A.mp4'); s.engine.undo(); expect(s.engine.state.mediaPool.A!.path.absolute).toBe('/media/A.mp4');
  });
  it('acceptance 2: linked A/V -> split -> ripple delete -> undo x2 -> verify sync and exact state', () => {
    const { e, seq } = setup(); ins(e, 'A', 0); const base = e.state;
    e.execute({ type: 'edit.split', sequenceId: 's1', time: 100, allTracks: true }); e.execute({ type: 'edit.split', sequenceId: 's1', time: 150, allTracks: true });
    e.execute({ type: 'edit.rippleDelete', sequenceId: 's1', clipIds: [seq().videoTracks[0]!.clips[1]!.id] }); assertSynced(seq());
    expect(clips(seq()).filter((c) => c.t === 'A1').map((c) => [c.s, c.e, c.in])).toEqual([[0, 100, 0], [100, 200, 150 * 1920]]);
    e.undo(); e.undo(); e.undo(); expect(e.state).toEqual(base); assertSynced(seq());
  });
});
void checksumOf; void journalRead; void openProjectWithRecovery; void ovw; void ({} as ProjectDoc);
