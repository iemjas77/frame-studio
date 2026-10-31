import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FPS, Frac, rate, time, convert, framesToTimecode, timecodeToFrames, interval, overlaps, subtract,
  sourceVideoFrameAt, sourceSampleAtBoundary, NORMAL_SPEED, seconds, rateFrac } from '../src/index.ts';

describe('rational', () => {
  it('rounds explicitly and deterministically', () => {
    expect(Frac.of(5, 2).round('nearest')).toBe(3n);
    expect(Frac.of(-5, 2).round('nearest')).toBe(-3n);
    expect(Frac.of(-5, 2).round('floor')).toBe(-3n);
    expect(Frac.of(-5, 2).round('ceil')).toBe(-2n);
    expect(Frac.of(7, 3).round('nearest')).toBe(2n);
  });
  it('represents NTSC rates exactly', () => {
    expect(FPS.f23_976).toEqual({ num: 24000, den: 1001 });
    expect(FPS.f29_97).toEqual({ num: 30000, den: 1001 });
    expect(FPS.f59_94).toEqual({ num: 60000, den: 1001 });
    expect(rate(48, 2)).toEqual({ num: 24, den: 1 });
  });
  it('rejects invalid rates', () => { expect(() => rate(0)).toThrow(); expect(() => rate(24.5)).toThrow(); });
  it('24 h at 29.97: exact time of frame 2589408 is 86400.0 s * (1000/1001 factor) with no drift', () => {
    // 24h of real time = 86400 s = 86400*30000/1001 frames = 2589410.58..; frame 2589408 is exactly 2589408*1001/30000 s
    const t = seconds(time(2589408, FPS.f29_97));
    expect(t.eq(Frac.of(2589408 * 1001, 30000))).toBe(true);
  });
  it('rate conversion round trips across 1,000,000 frames without drift (exact boundaries)', () => {
    for (const n of [0, 1, 999999, 1000000]) {
      const a = time(n, FPS.f23_976);
      const b = convert(a, rate(48000), 'nearest');
      // 23.976 -> 48k is exact: 2002 samples per frame
      expect(b.ticks).toBe(n * 2002);
      expect(convert(b, FPS.f23_976, 'floor').ticks).toBe(n);
    }
    // 29.97 -> 48k is 1601.6 samples/frame: boundaries computed independently, never accumulated
    let prev = 0; let sum = 0;
    for (let n = 1; n <= 30000; n++) { const s = convert(time(n, FPS.f29_97), rate(48000), 'nearest').ticks; const d = s - prev; expect([1601, 1602]).toContain(d); sum += d; prev = s; }
    expect(sum).toBe(48048000); // 30000 frames @29.97 = 1001 s exactly = 48,048,000 samples
  });
});

describe('timecode', () => {
  const ndf = (r = FPS.f24) => ({ rate: r, dropFrame: false });
  const df = { rate: FPS.f29_97, dropFrame: true };
  it('non-drop basic', () => {
    expect(framesToTimecode(0, ndf())).toBe('00:00:00:00');
    expect(framesToTimecode(24 * 3600 + 25, ndf())).toBe('01:00:01:01');
    expect(timecodeToFrames('01:00:01:01', ndf())).toBe(24 * 3600 + 25);
  });
  it('drop-frame known vectors (29.97)', () => {
    expect(framesToTimecode(1799, df)).toBe('00:00:59;29');
    expect(framesToTimecode(1800, df)).toBe('00:01:00;02');       // 00;00 and 00;01 skipped
    expect(framesToTimecode(17981, df)).toBe('00:09:59;29');
    expect(framesToTimecode(17982, df)).toBe('00:10:00;00');      // every 10th minute keeps its frames
    expect(framesToTimecode(107892, df)).toBe('01:00:00;00');     // 1 h of DF == 107892 frames
    expect(timecodeToFrames('01:00:00;00', df)).toBe(107892);
    expect(framesToTimecode(2589407, df)).toBe('23:59:59;29');
  });
  it('drop-frame 59.94 vectors', () => {
    const d = { rate: FPS.f59_94, dropFrame: true };
    expect(framesToTimecode(3599, d)).toBe('00:00:59;59');
    expect(framesToTimecode(3600, d)).toBe('00:01:00;04');
    expect(framesToTimecode(215784, d)).toBe('01:00:00;00');
  });
  it('rejects nonexistent drop-frame labels and mismatched separators', () => {
    expect(() => timecodeToFrames('00:01:00;00', df)).toThrow(/does not exist/);
    expect(() => timecodeToFrames('00:01:00:02', df)).toThrow(/separator/);
    expect(() => framesToTimecode(5, { rate: FPS.f25, dropFrame: true })).toThrow();
  });
  it('round-trips every frame for 2 hours of 29.97 DF and 25 NDF; labels strictly increase', () => {
    let last = '';
    for (let f = 0; f < 29.97 * 7200; f++) {
      const tc = framesToTimecode(f, df);
      expect(timecodeToFrames(tc, df)).toBe(f);
      expect(tc > last).toBe(true); last = tc;
    }
    fc.assert(fc.property(fc.integer({ min: -5_000_000, max: 5_000_000 }), (f) =>
      timecodeToFrames(framesToTimecode(f, ndf(FPS.f25)), ndf(FPS.f25)) === f));
  });
  it('drop-frame is numbering only: a DF hour label is within 3.6 ms of real time (no speed change)', () => {
    const real = seconds(time(107892, FPS.f29_97)); // frames -> real seconds
    expect(Math.abs(real.toNumber() - 3600 + 0.0036)).toBeLessThan(0.0001);
  });
});

describe('intervals (half-open)', () => {
  it('adjacent do not overlap', () => { expect(overlaps(interval(0, 10), interval(10, 20))).toBe(false); expect(overlaps(interval(0, 11), interval(10, 20))).toBe(true); });
  it('subtract', () => {
    expect(subtract(interval(0, 10), interval(3, 5))).toEqual([{ start: 0, end: 3 }, { start: 5, end: 10 }]);
    expect(subtract(interval(0, 10), interval(0, 10))).toEqual([]);
  });
});

describe('source mapping', () => {
  const seq25 = FPS.f25;
  const p = (over = {}) => ({ start: 100, sourceIn: time(50, FPS.f25), speed: NORMAL_SPEED, seqRate: seq25, ...over });
  it('identity at same rate', () => { for (let k = 100; k < 200; k++) expect(sourceVideoFrameAt(p(), k, FPS.f25)).toBe(50 + k - 100); });
  it('24 fps media on 25 fps sequence plays at real-time speed, repeating/skipping frames evenly, no drift over 1 h', () => {
    const q = p({ sourceIn: time(0, FPS.f24), start: 0 });
    const n = 25 * 3600;
    expect(sourceVideoFrameAt(q, 0, FPS.f24)).toBe(0);
    expect(sourceVideoFrameAt(q, n - 1, FPS.f24)).toBe(Math.floor(((2 * (n - 1) + 1) / 2) * 24 / 25));
    // frame shown after exactly 1 h of sequence time is source frame 86400 (24*3600)
    expect(sourceVideoFrameAt(q, n, FPS.f24)).toBe(86400);
    let skipped = 0; let prev = -1;
    for (let k = 0; k < 250; k++) { const f = sourceVideoFrameAt(q, k, FPS.f24); if (f === prev) skipped++; prev = f; }
    expect(skipped).toBe(10); // 24 -> 25 repeats 1 frame in every 25
  });
  it('half speed doubles frames; reverse counts down', () => {
    const half = p({ speed: { num: 1, den: 2 }, sourceIn: time(0, FPS.f25), start: 0 });
    expect([0, 1, 2, 3].map((k) => sourceVideoFrameAt(half, k, FPS.f25))).toEqual([0, 0, 1, 1]);
    const rev = p({ speed: { num: -1, den: 1 }, sourceIn: time(10, FPS.f25), start: 0 });
    expect([0, 1, 2].map((k) => sourceVideoFrameAt(rev, k, FPS.f25))).toEqual([9, 8, 7]);
  });
  it('audio boundaries are drift-free at 29.97 over a long clip', () => {
    const q = p({ seqRate: FPS.f29_97, sourceIn: time(0, rate(48000)), start: 0 });
    expect(sourceSampleAtBoundary(q, 30000, rate(48000))).toBe(48048000);
    expect(sourceSampleAtBoundary(q, 107892, rate(48000))).toBe(Math.round(107892 * 1001 * 48 / 30));
  });
  it('seconds sanity', () => { expect(rateFrac(FPS.f29_97).toNumber()).toBeCloseTo(29.97003, 5); });
});
