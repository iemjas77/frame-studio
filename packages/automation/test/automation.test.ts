import { describe, it, expect } from 'vitest';
import { FPS, time, rate } from '@fs/timeline-model';
import { makeProject, makeSequence } from '@fs/project-model';
import { CommandEngine, CommandError, type Command } from '@fs/command-engine';
import { parseMacro, validateMacro, expandMacro, runMacro, recordMacro, type Macro } from '../src/index.ts';

const media = { id: 'A', name: 'A.mp4', binId: null, path: { absolute: '/A.mp4' }, fingerprint: { size: 1, headHash: 'a', tailHash: 'b' }, metadata: {}, video: { codec: 'h264', width: 640, height: 360, rate: FPS.f25, duration: time(250, FPS.f25), rotation: 0, par: { num: 1, den: 1 }, colour: {} }, audio: { codec: 'aac', sampleRate: 48000, channels: 2, duration: time(480000, rate(48000)) } };
const mk = (committed?: Command[]) => { let n = 0; const e = new CommandEngine(makeProject('p', 'p', 'x'), { idSource: () => `t${++n}`, onCommit: (c) => { if ('command' in c) committed?.push(c.command); } });
  e.execute({ type: 'media.add', media: media as never }); e.execute({ type: 'sequence.create', sequence: makeSequence({ id: 's', name: 's', rate: FPS.f25 }) }); return e; };
const cutEvery: Macro = { version: 1, name: 'Add edit and marker', params: { at: { type: 'number' }, label: { type: 'string', default: 'cut' } }, steps: [
  { type: 'edit.split', sequenceId: 's', time: '${at}', allTracks: true }, { type: 'marker.add', sequenceId: 's', marker: { time: '${at}', duration: 0, name: 'edit ${label}', color: 'red', comment: '' } }] };

describe('macros', () => {
  it('substitutes typed parameters and runs as ONE undoable transaction', () => {
    const e = mk(); e.execute({ type: 'edit.insert', sequenceId: 's', mediaId: 'A', time: 0 }); const before = e.state; const depth = e.historyDepth;
    runMacro(e, cutEvery, { at: 100, label: 'x' }); expect(e.historyDepth).toBe(depth + 1);
    expect(e.state.sequences.s!.videoTracks[0]!.clips.length).toBe(2); expect(e.state.sequences.s!.markers[0]).toMatchObject({ time: 100, name: 'edit x' }); e.undo(); expect(e.state).toEqual(before);
  });
  it('is atomic: a failing step leaves everything untouched', () => {
    const e = mk(); e.execute({ type: 'edit.insert', sequenceId: 's', mediaId: 'A', time: 0 }); const before = e.state;
    expect(() => runMacro(e, cutEvery, { at: 9999 })).toThrow(CommandError); expect(e.state).toBe(before);
  });
  it('rejects non-allowlisted steps, unknown fields/params, wrong types, forbidden keys, oversize input', () => {
    expect(validateMacro({ ...cutEvery, steps: [{ type: 'media.add' }] }).map((i) => i.message).join()).toMatch(/not an allowed/);
    expect(validateMacro({ ...cutEvery, extra: 1 } as never).some((i) => i.message === 'unknown field')).toBe(true);
    expect(() => expandMacro(cutEvery, { at: '5' as never })).toThrow(/must be a number/); expect(() => expandMacro(cutEvery, { at: 1, nope: 1 })).toThrow(/unknown parameter/); expect(() => expandMacro(cutEvery, {})).toThrow(/missing parameter at/);
    expect(() => parseMacro('{"version":1,"name":"x","params":{},"steps":[{"type":"edit.lift","__proto__":{"a":1}}]}')).toThrow(/forbidden/); expect(() => parseMacro('x'.repeat(300_000))).toThrow(/too large/);
    expect(() => parseMacro(JSON.stringify({ version: 1, name: 'x', params: {}, steps: [{ type: 'edit.lift', sequenceId: '${evil}', clipIds: [] }] }))).toThrow(/unknown parameter/);
  });
  it('macro text is data only: placeholders never execute code', () => {
    const m: Macro = { version: 1, name: 'm', params: { n: { type: 'string', default: '${constructor.constructor("globalThis.__pwn=1")()}' } }, steps: [{ type: 'marker.add', sequenceId: 's', marker: { time: 1, duration: 0, name: '${n}', color: 'c', comment: '' } }] };
    const e = mk(); runMacro(e, m); expect((globalThis as Record<string, unknown>).__pwn).toBeUndefined(); expect(e.state.sequences.s!.markers[0]!.name).toContain('constructor');
  });
  it('recording then replaying on a fresh project reproduces the same result (round trip through JSON)', () => {
    const log: Command[] = []; const e = mk(log); log.length = 0;
    e.execute({ type: 'edit.insert', sequenceId: 's', mediaId: 'A', time: 0, sourceIn: time(0, FPS.f25), sourceOut: time(100, FPS.f25) }); e.execute({ type: 'edit.split', sequenceId: 's', time: 40, allTracks: true });
    e.execute({ type: 'media.update', mediaId: 'A', patch: { name: 'renamed' } });
    const { macro, skipped } = recordMacro('assemble', log); expect(skipped).toEqual(['media.update']);
    const f = mk(); runMacro(f, parseMacro(JSON.stringify(macro))); const strip = (d: typeof e.state) => JSON.stringify(d.sequences.s!.videoTracks.map((t) => t.clips.map((c) => [c.start, c.duration, c.sourceIn.ticks])));
    expect(strip(f.state)).toBe(strip(e.state));
  });
});
