import { describe, it, expect } from 'vitest';
import { FPS, time, rate } from '@fs/timeline-model';
import { CommandError } from '../src/index.ts';
import { setup, ins, ovw, clips, assertSynced, assertValid } from './helpers.ts';

const throwsCode = (fn: () => unknown, code: string) => { try { fn(); } catch (e) { expect((e as CommandError).code).toBe(code); return; } throw new Error(`expected ${code}`); };

describe('insert / overwrite / append', () => {
  it('inserts linked A/V as one group at the targeted tracks', () => {
    const { e, seq } = setup(); ins(e, 'A', 0);
    const s = seq(); const v = s.videoTracks[0]!.clips[0]!, a = s.audioTracks[0]!.clips[0]!;
    expect([v.start, v.duration, a.start, a.duration]).toEqual([0, 250, 0, 250]);
    expect(v.linkGroupId).toBeTruthy(); expect(v.linkGroupId).toBe(a.linkGroupId); assertSynced(s);
  });
  it('video-only / audio-only insertion create unlinked clips', () => {
    const { e, seq } = setup(); ins(e, 'A', 0, { only: 'video' }); ins(e, 'A', 300, { only: 'audio' });
    expect(seq().videoTracks[0]!.clips.length).toBe(1); expect(seq().audioTracks[0]!.clips[0]!.linkGroupId).toBeUndefined();
  });
  it('source in/out marks define the clip and sync offset', () => {
    const { e, seq } = setup(); ins(e, 'A', 10, { sourceIn: time(50, FPS.f25), sourceOut: time(100, FPS.f25) });
    const v = seq().videoTracks[0]!.clips[0]!, a = seq().audioTracks[0]!.clips[0]!;
    expect([v.start, v.duration, v.sourceIn.ticks]).toEqual([10, 50, 50]); expect(a.sourceIn.ticks).toBe(50 * 1920); assertSynced(seq());
  });
  it('rejects a source range beyond the media', () => {
    const { e } = setup(); throwsCode(() => ins(e, 'B', 0, { sourceIn: time(50, FPS.f25), sourceOut: time(150, FPS.f25) }), 'InsufficientHandle');
  });
  it('insert in the middle splits spanning clips on every sync-locked track and shifts the right half; sync is kept', () => {
    const { e, seq } = setup(); ins(e, 'A', 0); ins(e, 'B', 100);
    const c = clips(seq()); // A: 0..100, B: 100..200, A(right): 200..350
    expect(c.filter((x) => x.t === 'V1').map((x) => [x.s, x.e, x.m])).toEqual([[0, 100, 'A'], [100, 200, 'B'], [200, 350, 'A']]);
    expect(c.filter((x) => x.t === 'A1').map((x) => [x.s, x.e])).toEqual([[0, 100], [100, 200], [200, 350]]);
    assertSynced(seq()); assertValid(e.state);
    // right half continues the source exactly where the left half stopped
    expect(seq().videoTracks[0]!.clips[2]!.sourceIn.ticks).toBe(100);
  });
  it('insert shifts content on a non-target sync-locked track (V2) but not when its sync lock is off', () => {
    const { e, seq } = setup(); e.execute({ type: 'edit.overwrite', sequenceId: 's1', mediaId: 'B', time: 50, targets: { video: 's1_V2' }, only: 'video' });
    ins(e, 'B', 0, { only: 'video' }); expect(seq().videoTracks[1]!.clips[0]!.start).toBe(150);
    e.execute({ type: 'track.set', sequenceId: 's1', trackId: 's1_V2', patch: { syncLock: false } }); ins(e, 'B', 0, { only: 'video' });
    expect(seq().videoTracks[1]!.clips[0]!.start).toBe(150);
  });
  it('FAILS (no change) when a locked, sync-locked track has content after the insert point; passes if its sync lock is off', () => {
    const { e, seq } = setup(); ovw(e, 'B', 20, { targets: { video: 's1_V2' }, only: 'video' });
    e.execute({ type: 'track.set', sequenceId: 's1', trackId: 's1_V2', patch: { locked: true } });
    const before = e.state; throwsCode(() => ins(e, 'A', 0), 'LockedTrackConflict'); expect(e.state).toBe(before);
    e.execute({ type: 'track.set', sequenceId: 's1', trackId: 's1_V2', patch: { syncLock: false } }); ins(e, 'A', 0);
    expect(seq().videoTracks[1]!.clips[0]!.start).toBe(20);
  });
  it('refuses to edit a locked target track', () => {
    const { e } = setup(); e.execute({ type: 'track.set', sequenceId: 's1', trackId: 's1_A1', patch: { locked: true } });
    throwsCode(() => ovw(e, 'A', 0), 'LockedTrack');
  });
  it('overwrite replaces exactly [t, t+len): splits, trims and removes without changing total length', () => {
    const { e, seq } = setup(); ins(e, 'A', 0); ovw(e, 'B', 50);
    const v = clips(seq()).filter((x) => x.t === 'V1').map((x) => [x.s, x.e, x.m]);
    expect(v).toEqual([[0, 50, 'A'], [50, 150, 'B'], [150, 250, 'A']]); assertSynced(seq());
    expect(seq().videoTracks[0]!.clips[2]!.sourceIn.ticks).toBe(150);
  });
  it('overwrite clips adjacent half-open boundaries correctly (no sliver)', () => {
    const { e, seq } = setup(); ins(e, 'B', 0); ovw(e, 'B', 100);
    expect(clips(seq()).filter((x) => x.t === 'V1').map((x) => [x.s, x.e])).toEqual([[0, 100], [100, 200]]);
  });
  it('append goes after the last clip of the targets', () => {
    const { e, seq } = setup(); ins(e, 'B', 0); e.execute({ type: 'edit.append', sequenceId: 's1', mediaId: 'B' });
    expect(clips(seq()).filter((x) => x.t === 'V1').map((x) => [x.s, x.e])).toEqual([[0, 100], [100, 200]]);
  });
  it('29.97 sequence with 25 fps media: duration floors to whole frames inside the source', () => {
    const { e, seq } = setup({ rate: FPS.f29_97 }); ins(e, 'A', 0); const v = seq().videoTracks[0]!.clips[0]!;
    expect(v.duration).toBe(Math.floor(10 * 30000 / 1001)); assertValid(e.state); assertSynced(seq());
  });
});

describe('split', () => {
  it('splits linked pair and is undone exactly', () => {
    const { e, seq } = setup(); ins(e, 'A', 0); const before = e.state;
    const v = seq().videoTracks[0]!.clips[0]!; e.execute({ type: 'edit.split', sequenceId: 's1', time: 100, clipIds: [v.id] });
    const c = clips(seq()); expect(c.filter((x) => x.s === 100).map((x) => x.t).sort()).toEqual(['A1', 'V1']);
    const rv = seq().videoTracks[0]!.clips[1]!, ra = seq().audioTracks[0]!.clips[1]!; expect(rv.linkGroupId).toBe(ra.linkGroupId); expect(rv.linkGroupId).not.toBe(v.linkGroupId);
    assertSynced(seq()); e.undo(); expect(e.state).toEqual(before); e.redo(); expect(clips(e.state.sequences.s1!).length).toBe(4);
  });
  it('allTracks skips locked tracks; split outside any clip is an error', () => {
    const { e, seq } = setup(); ins(e, 'A', 0); e.execute({ type: 'track.set', sequenceId: 's1', trackId: 's1_A1', patch: { locked: true } });
    e.execute({ type: 'edit.split', sequenceId: 's1', time: 40, allTracks: true }); expect(seq().audioTracks[0]!.clips.length).toBe(1); expect(seq().videoTracks[0]!.clips.length).toBe(2);
    throwsCode(() => e.execute({ type: 'edit.split', sequenceId: 's1', time: 999, allTracks: true }), 'NothingToDo');
    throwsCode(() => e.execute({ type: 'edit.split', sequenceId: 's1', time: 40, clipIds: [seq().audioTracks[0]!.clips[0]!.id] }), 'LockedTrack');
  });
  it('split at a clip boundary is rejected (never creates zero-length clips)', () => {
    const { e, seq } = setup(); ins(e, 'A', 0); throwsCode(() => e.execute({ type: 'edit.split', sequenceId: 's1', time: 0, clipIds: [seq().videoTracks[0]!.clips[0]!.id] }), 'NothingToDo');
  });
  it('29.97 sequence: split halves share an exact boundary in source time (no gap, no overlap, no drift)', () => {
    const { e, seq } = setup({ rate: FPS.f29_97 }); ins(e, 'A', 0);
    e.execute({ type: 'edit.split', sequenceId: 's1', time: 101, allTracks: true }); assertSynced(seq()); assertValid(e.state);
    const [l, r] = seq().audioTracks[0]!.clips; expect(l!.start + l!.duration).toBe(r!.start);
  });
});

describe('trim / slip', () => {
  const setupTwo = () => { const x = setup(); ins(x.e, 'B', 0); ins(x.e, 'B', 150, {}); return x; }; // B 0..100, gap, B 150..250
  it('trims end/start (non-ripple) on linked pair, keeping sync', () => {
    const { e, seq } = setup(); ins(e, 'A', 10, { sourceIn: time(20, FPS.f25), sourceOut: time(120, FPS.f25) });
    const v = seq().videoTracks[0]!.clips[0]!; e.execute({ type: 'edit.trim', sequenceId: 's1', clipId: v.id, edge: 'end', toTime: 90 });
    e.execute({ type: 'edit.trim', sequenceId: 's1', clipId: v.id, edge: 'start', toTime: 30 });
    const nv = seq().videoTracks[0]!.clips[0]!, na = seq().audioTracks[0]!.clips[0]!;
    expect([nv.start, nv.duration, nv.sourceIn.ticks]).toEqual([30, 60, 40]); expect([na.start, na.duration]).toEqual([30, 60]); assertSynced(seq());
  });
  it('extending uses handles; fails cleanly when handles run out or a neighbour is in the way', () => {
    const { e, seq } = setupTwo(); const v = seq().videoTracks[0]!.clips[0]!;
    throwsCode(() => e.execute({ type: 'edit.trim', sequenceId: 's1', clipId: v.id, edge: 'end', toTime: 101 }), 'InsufficientHandle');
    const w = seq().videoTracks[0]!.clips[1]!; throwsCode(() => e.execute({ type: 'edit.trim', sequenceId: 's1', clipId: w.id, edge: 'start', toTime: 149 }), 'InsufficientHandle');
    const { e: e2, seq: s2 } = setup(); ins(e2, 'A', 0, { sourceIn: time(0, FPS.f25), sourceOut: time(50, FPS.f25) }); ovw(e2, 'A', 60, { sourceIn: time(100, FPS.f25), sourceOut: time(150, FPS.f25) });
    throwsCode(() => e2.execute({ type: 'edit.trim', sequenceId: 's1', clipId: s2().videoTracks[0]!.clips[0]!.id, edge: 'end', toTime: 70 }), 'Collision');
    e2.execute({ type: 'edit.trim', sequenceId: 's1', clipId: s2().videoTracks[0]!.clips[0]!.id, edge: 'end', toTime: 60 }); assertValid(e2.state);
  });
  it('ripple trim end shortens and closes the gap on all sync-locked tracks; undo restores', () => {
    const { e, seq } = setup(); ins(e, 'B', 0); ins(e, 'B', 100); const before = e.state;
    const v = seq().videoTracks[0]!.clips[0]!; e.execute({ type: 'edit.trim', sequenceId: 's1', clipId: v.id, edge: 'end', toTime: 60, ripple: true });
    expect(clips(seq()).filter((x) => x.t === 'V1' || x.t === 'A1').map((x) => [x.t, x.s, x.e]).sort()).toEqual([['A1', 0, 60], ['A1', 60, 160], ['V1', 0, 60], ['V1', 60, 160]]); assertSynced(seq());
    e.undo(); expect(e.state).toEqual(before);
  });
  it('ripple trim end lengthening pushes later content right', () => {
    const { e, seq } = setup(); ins(e, 'A', 0, { sourceIn: time(0, FPS.f25), sourceOut: time(50, FPS.f25) }); ins(e, 'B', 50);
    e.execute({ type: 'edit.trim', sequenceId: 's1', clipId: seq().videoTracks[0]!.clips[0]!.id, edge: 'end', toTime: 80, ripple: true });
    expect(seq().videoTracks[0]!.clips.map((c) => [c.start, c.start + c.duration])).toEqual([[0, 80], [80, 180]]); assertSynced(seq());
  });
  it('ripple trim start keeps the clip start, advances source-in, shifts later content left', () => {
    const { e, seq } = setup(); ins(e, 'B', 0); ins(e, 'B', 100);
    e.execute({ type: 'edit.trim', sequenceId: 's1', clipId: seq().videoTracks[0]!.clips[0]!.id, edge: 'start', toTime: 20, ripple: true });
    const c = seq().videoTracks[0]!.clips; expect([c[0]!.start, c[0]!.duration, c[0]!.sourceIn.ticks, c[1]!.start]).toEqual([0, 80, 20, 80]); assertSynced(seq());
  });
  it('ripple that would collide on another track is refused unless allowPartial', () => {
    const { e, seq } = setup(); ins(e, 'B', 0); ovw(e, 'B', 90, { targets: { video: 's1_V2' }, only: 'video' }); // V2 clip at 90..190 straddles V1 clip end(100)
    const v = seq().videoTracks[0]!.clips[0]!; throwsCode(() => e.execute({ type: 'edit.trim', sequenceId: 's1', clipId: v.id, edge: 'end', toTime: 50, ripple: true }), 'RippleBlocked');
  });
  it('slip moves source under a fixed placement, within handles', () => {
    const { e, seq } = setup(); ins(e, 'A', 0, { sourceIn: time(50, FPS.f25), sourceOut: time(100, FPS.f25) });
    e.execute({ type: 'edit.slip', sequenceId: 's1', clipId: seq().videoTracks[0]!.clips[0]!.id, deltaFrames: -20 });
    const v = seq().videoTracks[0]!.clips[0]!; expect([v.start, v.duration, v.sourceIn.ticks]).toEqual([0, 50, 30]); assertSynced(seq());
    throwsCode(() => e.execute({ type: 'edit.slip', sequenceId: 's1', clipId: v.id, deltaFrames: -31 }), 'InsufficientHandle');
  });
});

describe('lift / ripple delete / gap / move / link', () => {
  it('lift leaves a gap (linked removed together)', () => {
    const { e, seq } = setup(); ins(e, 'B', 0); ins(e, 'B', 100);
    e.execute({ type: 'edit.lift', sequenceId: 's1', clipIds: [seq().videoTracks[0]!.clips[0]!.id] });
    expect(clips(seq()).map((x) => [x.t, x.s])).toEqual([['V1', 100], ['A1', 100]]);
  });
  it('ripple delete closes the gap across V and A; sync and undo preserved', () => {
    const { e, seq } = setup(); ins(e, 'B', 0); ins(e, 'B', 100); ins(e, 'B', 200); const before = e.state;
    e.execute({ type: 'edit.rippleDelete', sequenceId: 's1', clipIds: [seq().videoTracks[0]!.clips[1]!.id] });
    expect(seq().videoTracks[0]!.clips.map((c) => c.start)).toEqual([0, 100]); expect(seq().audioTracks[0]!.clips.map((c) => c.start)).toEqual([0, 100]); assertSynced(seq());
    e.undo(); expect(e.state).toEqual(before);
  });
  it('ripple delete is blocked (not silently partial) by a straddling clip on another sync track', () => {
    const { e, seq } = setup(); ins(e, 'B', 0); ins(e, 'B', 100); ovw(e, 'B', 90, { targets: { video: 's1_V2' }, only: 'video' });
    const before = e.state; throwsCode(() => e.execute({ type: 'edit.rippleDelete', sequenceId: 's1', clipIds: [seq().videoTracks[0]!.clips[0]!.id] }), 'RippleBlocked');
    expect(e.state).toBe(before);
    e.execute({ type: 'edit.rippleDelete', sequenceId: 's1', clipIds: [seq().videoTracks[0]!.clips[0]!.id], allowPartial: true }); assertValid(e.state);
  });
  it('ripple delete with a locked sync-locked track holding later content fails; works when that track has sync lock off', () => {
    const { e, seq } = setup(); ins(e, 'B', 0); ovw(e, 'B', 150, { targets: { video: 's1_V2' }, only: 'video' });
    e.execute({ type: 'track.set', sequenceId: 's1', trackId: 's1_V2', patch: { locked: true } });
    throwsCode(() => e.execute({ type: 'edit.rippleDelete', sequenceId: 's1', clipIds: [seq().videoTracks[0]!.clips[0]!.id] }), 'LockedTrackConflict');
    e.execute({ type: 'track.set', sequenceId: 's1', trackId: 's1_V2', patch: { syncLock: false } });
    e.execute({ type: 'edit.rippleDelete', sequenceId: 's1', clipIds: [seq().videoTracks[0]!.clips[0]!.id] }); expect(seq().videoTracks[1]!.clips[0]!.start).toBe(150);
  });
  it('removeGap closes an empty gap', () => {
    const { e, seq } = setup(); ins(e, 'B', 0); ins(e, 'B', 100); e.execute({ type: 'edit.lift', sequenceId: 's1', clipIds: [seq().videoTracks[0]!.clips[0]!.id] });
    e.execute({ type: 'edit.removeGap', sequenceId: 's1', trackId: 's1_V1', time: 10 }); expect(clips(seq()).map((x) => [x.t, x.s])).toEqual([['V1', 0], ['A1', 0]]);
  });
  it('move: strict collision error; overwrite mode; linked move; cross-track', () => {
    const { e, seq } = setup(); ins(e, 'B', 0); ovw(e, 'B', 150); const id = seq().videoTracks[0]!.clips[0]!.id;
    throwsCode(() => e.execute({ type: 'edit.move', sequenceId: 's1', clipIds: [id], deltaFrames: 100 }), 'Collision');
    e.execute({ type: 'edit.move', sequenceId: 's1', clipIds: [id], deltaFrames: 40 }); expect(seq().audioTracks[0]!.clips[0]!.start).toBe(40);
    e.execute({ type: 'edit.move', sequenceId: 's1', clipIds: [id], deltaFrames: 0, trackDelta: { video: 1 } }); expect(seq().videoTracks[1]!.clips.length).toBe(1); assertSynced(seq());
    e.execute({ type: 'edit.move', sequenceId: 's1', clipIds: [id], deltaFrames: 100, mode: 'overwrite', trackDelta: { video: -1 } }); assertValid(e.state);
    throwsCode(() => e.execute({ type: 'edit.move', sequenceId: 's1', clipIds: [id], deltaFrames: -1000 }), 'InvalidArgument');
  });
  it('link/unlink: unlinked trims move only one side (explicit desync), relink merges', () => {
    const { e, seq } = setup(); ins(e, 'B', 0); const v = seq().videoTracks[0]!.clips[0]!, a = seq().audioTracks[0]!.clips[0]!;
    e.execute({ type: 'edit.unlink', sequenceId: 's1', clipIds: [v.id] }); expect(seq().audioTracks[0]!.clips[0]!.linkGroupId).toBeUndefined();
    e.execute({ type: 'edit.trim', sequenceId: 's1', clipId: v.id, edge: 'end', toTime: 50 }); expect(seq().audioTracks[0]!.clips[0]!.duration).toBe(100);
    e.execute({ type: 'edit.link', sequenceId: 's1', clipIds: [v.id, a.id] }); expect(seq().videoTracks[0]!.clips[0]!.linkGroupId).toBe(seq().audioTracks[0]!.clips[0]!.linkGroupId);
  });
  it('markers and sequence range', () => {
    const { e, seq } = setup(); e.execute({ type: 'marker.add', sequenceId: 's1', marker: { time: 10, duration: 0, name: 'm', color: 'red', comment: '' } });
    e.execute({ type: 'sequence.setRange', sequenceId: 's1', inPoint: 5, outPoint: 50 }); expect(seq().markers.length).toBe(1); expect(seq().inPoint).toBe(5);
    throwsCode(() => e.execute({ type: 'sequence.setRange', sequenceId: 's1', inPoint: 50, outPoint: 5 }), 'Invariant');
  });
  it('media.remove refuses when in use', () => { const { e } = setup(); ins(e, 'B', 0); throwsCode(() => e.execute({ type: 'media.remove', mediaId: 'B' }), 'MediaInUse'); e.execute({ type: 'media.remove', mediaId: 'A' }); });
});
void rate;

describe('rolling edit / slide', () => {
  const abut = () => { const x = setup(); ins(x.e, 'A', 0, { sourceIn: time(50, FPS.f25), sourceOut: time(100, FPS.f25) }); ovw(x.e, 'A', 50, { sourceIn: time(120, FPS.f25), sourceOut: time(170, FPS.f25) }); ovw(x.e, 'B', 100, { sourceIn: time(10, FPS.f25), sourceOut: time(60, FPS.f25) }); return x; };
  it('rolling moves the cut, keeps total span and sync, uses handles, undoes exactly', () => {
    const { e, seq } = abut(); const before = e.state; const [l] = seq().videoTracks[0]!.clips;
    e.execute({ type: 'edit.rolling', sequenceId: 's1', leftClipId: l!.id, delta: 10 });
    const c = seq().videoTracks[0]!.clips; expect(c.map((x) => [x.start, x.duration, x.sourceIn.ticks])).toEqual([[0, 60, 50], [60, 40, 130], [100, 50, 10]]); assertSynced(seq()); assertValid(e.state);
    expect(seq().audioTracks[0]!.clips.map((x) => [x.start, x.duration])).toEqual([[0, 60], [60, 40], [100, 50]]);        // linked audio rolled too
    e.undo(); expect(e.state).toEqual(before);
    throwsCode(() => e.execute({ type: 'edit.rolling', sequenceId: 's1', leftClipId: l!.id, delta: -60 }), 'InvalidArgument');
    throwsCode(() => e.execute({ type: 'edit.rolling', sequenceId: 's1', leftClipId: l!.id, delta: 71 }), 'InvalidArgument');      // would shrink the right clip below one frame
    throwsCode(() => e.execute({ type: 'edit.rolling', sequenceId: 's1', leftClipId: seq().videoTracks[0]!.clips[1]!.id, delta: -11 }), 'InsufficientHandle');   // third clip's source starts at frame 10: rolling its head back 11 runs out of media
  });
  it('rolling across a gap is refused; locked tracks refused', () => {
    const { e, seq } = setup(); ins(e, 'B', 0); ovw(e, 'B', 150); throwsCode(() => e.execute({ type: 'edit.rolling', sequenceId: 's1', leftClipId: seq().videoTracks[0]!.clips[0]!.id, delta: 5 }), 'InvalidArgument');
    const x = abut(); x.e.execute({ type: 'track.set', sequenceId: 's1', trackId: 's1_V1', patch: { locked: true } }); throwsCode(() => x.e.execute({ type: 'edit.rolling', sequenceId: 's1', leftClipId: x.seq().videoTracks[0]!.clips[0]!.id, delta: 5 }), 'LockedTrack');
  });
  it('slide moves the middle clip while neighbours absorb it; source of the slid clip is unchanged; needs both neighbours', () => {
    const { e, seq } = abut(); const mid = seq().videoTracks[0]!.clips[1]!;
    e.execute({ type: 'edit.slide', sequenceId: 's1', clipId: mid.id, delta: -8 });
    expect(seq().videoTracks[0]!.clips.map((x) => [x.start, x.duration, x.sourceIn.ticks])).toEqual([[0, 42, 50], [42, 50, 120], [92, 58, 2]]); assertSynced(seq()); assertValid(e.state);
    throwsCode(() => e.execute({ type: 'edit.slide', sequenceId: 's1', clipId: seq().videoTracks[0]!.clips[0]!.id, delta: 3 }), 'InvalidArgument');
    throwsCode(() => e.execute({ type: 'edit.slide', sequenceId: 's1', clipId: seq().videoTracks[0]!.clips[1]!.id, delta: -41 }), 'InsufficientHandle');   // third clip head would need source before frame 0
  });
});
