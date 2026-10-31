import { describe, it, expect } from 'vitest';
import { FPS, time } from '@fs/timeline-model';
import { makeProject, makeSequence } from '@fs/project-model';
import { CommandEngine } from '@fs/command-engine';
import { Transport, videoLayersAt, audioSegments, sequenceEnd, activeAudioClips } from '../src/index.ts';

const clock = () => { let t = 0; return { now: () => t, adv: (ms: number) => { t += ms; } }; };
const mk = (dur = 100) => { const c = clock(); const tr = new Transport({ rate: FPS.f25, duration: () => dur, now: c.now }); return { c, tr }; };

describe('transport', () => {
  it('derives position from the clock without accumulating error (29.97, 1 h of 16 ms ticks)', () => {
    const c = clock(); const tr = new Transport({ rate: FPS.f29_97, duration: () => 10_000_000, now: c.now }); tr.play();
    for (let i = 0; i < 225_000; i++) c.adv(16); // 3600 s in 16 ms ticks
    expect(tr.position()).toBe(Math.floor(3600 * 30000 / 1001)); // 107892
  });
  it('seek bumps generation; stale frames are rejected, latest accepted', () => {
    const { tr } = mk(); const g1 = tr.seek(10); const g2 = tr.seek(50);
    expect(tr.present(g1, 10)).toBe(false); expect(tr.present(g2, 50)).toBe(true); expect(tr.position()).toBe(50);
  });
  it('async results arriving out of order never display an older position', () => {
    const { tr } = mk(); const shown: number[] = []; const gens = [5, 20, 35, 60].map((f) => ({ f, g: tr.seek(f) }));
    for (const r of [gens[2]!, gens[0]!, gens[3]!, gens[1]!]) if (tr.present(r.g, r.f)) shown.push(r.f); // completion order scrambled
    expect(shown).toEqual([60]);
  });
  it('plays at rate, pauses where it is, steps, and stops at the end (or loops)', () => {
    const { c, tr } = mk(100); tr.seek(10); tr.play(); c.adv(400); expect(tr.position()).toBe(20); tr.pause(); c.adv(1000); expect(tr.position()).toBe(20);
    tr.step(-3); expect(tr.position()).toBe(17); tr.seek(95); tr.play(); c.adv(1000); expect(tr.position()).toBe(99); expect(tr.state).toBe('paused');
    const c2 = clock(); let lp: any = { start: 10, end: 20 }; const t2 = new Transport({ rate: FPS.f25, duration: () => 100, now: c2.now, loop: () => lp }); t2.seek(10); t2.play(); c2.adv(480); expect(t2.position()).toBe(12); lp = null;
  });
  it('J/K/L shuttle: L,L,L doubles speed up to 8x; J reverses; K pauses', () => {
    const { c, tr } = mk(10_000); tr.seek(1000); tr.shuttle('L'); expect(tr.speed).toBe(1); tr.shuttle('L'); tr.shuttle('L'); expect(tr.speed).toBe(4); tr.shuttle('L'); tr.shuttle('L'); expect(tr.speed).toBe(8);
    tr.shuttle('J'); expect([tr.direction, tr.speed]).toEqual([-1, 1]); c.adv(1000); expect(tr.position()).toBeLessThan(1000); tr.shuttle('K'); expect(tr.state).toBe('paused');
  });
  it('reports dropped frames only during playback', () => {
    const { c, tr } = mk(); tr.play(); const g = tr.generation; c.adv(40); tr.present(g, 1); tr.present(g, 2); tr.present(g, 5); expect(tr.dropped).toBe(2);
    tr.pause(); const g2 = tr.seek(40); tr.present(g2, 40); tr.present(g2, 60); expect(tr.dropped).toBe(2);
  });
});

describe('shared evaluator', () => {
  const build = () => {
    const e = new CommandEngine(makeProject('p', 'p', 'x'), { idSource: (() => { let n = 0; return () => `t${++n}`; })() });
    const media = (id: string, f: number) => ({ id, name: id, binId: null, path: { absolute: `/${id}` }, fingerprint: { size: 1, headHash: 'a', tailHash: 'b' }, metadata: {},
      video: { codec: 'h264', width: 640, height: 360, rate: FPS.f25, duration: time(f, FPS.f25), rotation: 0, par: { num: 1, den: 1 }, colour: {} }, audio: { codec: 'aac', sampleRate: 48000, channels: 2, duration: time(f * 1920, { num: 48000, den: 1 }) } });
    e.execute({ type: 'media.add', media: media('A', 250) as any }); e.execute({ type: 'media.add', media: media('B', 100) as any });
    e.execute({ type: 'sequence.create', sequence: makeSequence({ id: 's', name: 's', rate: FPS.f25 }) });
    return e;
  };
  it('top track wins; gaps are empty; source frame follows trims', () => {
    const e = build(); e.execute({ type: 'edit.overwrite', sequenceId: 's', mediaId: 'A', time: 0, sourceIn: time(100, FPS.f25), sourceOut: time(200, FPS.f25) });
    e.execute({ type: 'edit.overwrite', sequenceId: 's', mediaId: 'B', time: 20, targets: { video: 's_V2' }, only: 'video' });
    const seq = e.state.sequences.s!; expect(videoLayersAt(e.state, seq, 10)[0]).toMatchObject({ mediaId: 'A', sourceFrame: 110 });
    expect(videoLayersAt(e.state, seq, 30).map((l) => [l.mediaId, l.sourceFrame])).toEqual([['B', 10], ['A', 130]]);
    expect(videoLayersAt(e.state, seq, 120)).toEqual([]); expect(sequenceEnd(seq)).toBe(120);
  });
  it('hidden tracks/disabled clips drop out; mute and solo gate audio', () => {
    const e = build(); e.execute({ type: 'edit.insert', sequenceId: 's', mediaId: 'A', time: 0 });
    e.execute({ type: 'track.set', sequenceId: 's', trackId: 's_V1', patch: { visible: false } }); expect(videoLayersAt(e.state, e.state.sequences.s!, 5)).toEqual([]);
    e.execute({ type: 'track.set', sequenceId: 's', trackId: 's_A1', patch: { muted: true } }); expect(activeAudioClips(e.state.sequences.s!)).toEqual([]);
    e.execute({ type: 'track.set', sequenceId: 's', trackId: 's_A1', patch: { muted: false, solo: true } }); expect(activeAudioClips(e.state.sequences.s!).length).toBe(1);
  });
  it('audio segments tile without gaps/overlaps at 29.97 across splits (sample-exact, no drift)', () => {
    const e = build(); e.execute({ type: 'sequence.create', sequence: makeSequence({ id: 'n', name: 'n', rate: FPS.f29_97 }) });
    e.execute({ type: 'edit.insert', sequenceId: 'n', mediaId: 'A', time: 0 });
    for (const t of [101, 150, 200, 250]) e.execute({ type: 'edit.split', sequenceId: 'n', time: t, allTracks: true });
    const segs = audioSegments(e.state, e.state.sequences.n!).sort((a, b) => a.outStartSample - b.outStartSample);
    let at = 0; let src = segs[0]!.sourceStartSample; for (const s of segs) { expect(s.outStartSample).toBe(at); expect(Math.abs(s.sourceStartSample - src)).toBeLessThanOrEqual(1); at += s.sampleCount; src = s.sourceStartSample + s.sampleCount; }
    const seq = e.state.sequences.n!; expect(at).toBe(Math.round(seq.audioTracks[0]!.clips.reduce((a, c) => a + c.duration, 0) * 1001 * 48 / 30));
  });
});
