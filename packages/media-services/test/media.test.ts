import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs'; import * as os from 'node:os'; import * as path from 'node:path';
import { FPS, rate } from '@fs/timeline-model';
import { MediaError } from '@fs/media-contracts';
import { ensureFixtures, probeMedia, toMediaRef, decodeFrameGray, readFrameStrip, SequentialFrameSource, waveformPeaks, runBounded } from '../src/index.ts';

let fx: Record<string, string>; let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-fx-')); fx = ensureFixtures(dir); }, 120_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('probe', () => {
  it('reads CFR video + audio with exact rational rate and sample-exact audio', async () => {
    const p = await probeMedia(fx.A!); expect(p.video!.rate).toEqual(FPS.f25); expect(p.video!.frameCount).toBe(250); expect([p.video!.width, p.video!.height]).toEqual([640, 360]);
    expect(p.audio!.sampleRate).toBe(48000); expect(p.audio!.channels).toBe(2); expect(p.fingerprint.size).toBe(p.size);
    expect(p.warnings.join()).toMatch(/no colour metadata/); // unspecified colour is reported, never guessed
  });
  it('NTSC rates are exact rationals', async () => {
    expect((await probeMedia(fx.B!)).video!.rate).toEqual(FPS.f23_976); const c = await probeMedia(fx.C!); expect(c.video!.rate).toEqual(FPS.f29_97); expect(c.video!.hasBFrames).toBe(true); expect(c.video!.frameCount).toBe(Math.round(8 * 30000 / 1001));
  });
  it('audio-only, 44.1 kHz mono', async () => { const p = await probeMedia(fx.D!); expect(p.video).toBeUndefined(); expect([p.audio!.sampleRate, p.audio!.channels]).toEqual([44100, 1]); expect(p.audio!.sampleCount).toBeGreaterThan(5 * 44100 - 50); });
  it('rotation metadata and nonzero start timestamps are surfaced', async () => {
    expect((await probeMedia(fx.E!)).video!.rotation).toBe(270); /* clockwise degrees to apply; ffmpeg -display_rotation 90 is 90 deg counter-clockwise */ expect((await probeMedia(fx.G!)).video!.startSec).toBeCloseTo(3.5, 1);
  });
  it('malformed inputs fail with typed errors, not hangs or crashes', async () => {
    await expect(probeMedia(fx.Z!)).rejects.toMatchObject({ code: 'Empty' }); await expect(probeMedia(path.join(dir, 'nope.mp4'))).rejects.toMatchObject({ code: 'NotFound' });
    await expect(probeMedia(dir)).rejects.toMatchObject({ code: 'NotAFile' });
    const r = await probeMedia(fx.F!).then((p) => ({ ok: true as const, p }), (e) => ({ ok: false as const, e })); // truncated mp4 (moov at front thanks to faststart may still parse)
    if (!r.ok) expect(r.e).toBeInstanceOf(MediaError);
  });
  it('enforces timeout and output limits on subprocesses', async () => {
    await expect(runBounded('sleep', ['5'], { timeoutMs: 200, maxOutputBytes: 1000 })).rejects.toMatchObject({ code: 'Timeout' });
    await expect(runBounded('yes', [], { timeoutMs: 5000, maxOutputBytes: 5000 })).rejects.toMatchObject({ code: 'TooMuchOutput' });
    await expect(runBounded('definitely-not-a-tool', [], { timeoutMs: 1000, maxOutputBytes: 10 })).rejects.toMatchObject({ code: 'ToolMissing' });
  });
  it('filenames with spaces/quotes/shell metacharacters are passed as data, never interpreted', async () => {
    const weird = path.join(dir, "we ird; $(touch pwned) 'q'.mp4"); fs.copyFileSync(fx.A!, weird);
    expect((await probeMedia(weird)).video!.frameCount).toBe(250); expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false);
  });
  it('MediaRef conversion keeps exact timing and relative path', async () => {
    const m = toMediaRef(await probeMedia(fx.A!), 'm1', dir); expect(m.video!.duration).toEqual({ ticks: 250, rate: FPS.f25 }); expect(m.path.relative).toBe('A_25fps_10s.mp4'); expect(m.audio!.duration.rate).toEqual(rate(48000));
  });
});

describe('frame decode', () => {
  const frameAt = async (f: string, k: number, r: any) => readFrameStrip(await decodeFrameGray(f, k, r, 640, 360), 640);
  it('identifies exact source frames via the embedded counter for CFR, NTSC, long-GOP/B-frame and nonzero-start media', async () => {
    for (const [key, r, ks] of [['A', FPS.f25, [0, 1, 24, 25, 26, 137, 249]], ['B', FPS.f23_976, [0, 47, 48, 100, 143]], ['C', FPS.f29_97, [0, 1, 100, 150, 238]], ['G', FPS.f25, [0, 77]]] as const)
      for (const k of ks) expect(await frameAt(fx[key]!, k, r)).toBe(k);
  }, 120_000);
  it('sequential source reuses one process for forward playback and restarts only on seek', async () => {
    const src = new SequentialFrameSource(fx.A!, FPS.f25, 320); try {
      for (let k = 10; k < 40; k++) expect((await src.get(k)).subarray(0, 2).toString('hex')).toBe('ffd8');
      expect(src.spawns).toBe(1); await src.get(200); expect(src.spawns).toBe(2);
    } finally { src.kill(); }
  }, 60_000);
  it('waveform peaks reflect audio level and are bounded', async () => { const w = await waveformPeaks(fx.A!, 100); expect(w.peaks.length).toBeLessThanOrEqual(100); expect(Math.max(...w.peaks)).toBeGreaterThan(0.05); expect(w.durationSec).toBeGreaterThan(9.9); }, 30_000);
});

describe('relink identity (acceptance 5 support)', () => {
  it('identical copy under another name/place is accepted; same-named different file is refused; re-wrapped file needs confirmation', async () => {
    const { assessIdentity } = await import('../src/index.ts');
    const ref = toMediaRef(await probeMedia(fx.A!), 'm', dir);
    const copy = path.join(dir, 'renamed copy.mp4'); fs.copyFileSync(fx.A!, copy);
    expect((assessIdentity(ref, await probeMedia(copy))).verdict).toBe('identical');
    expect(assessIdentity(ref, await probeMedia(fx.B!)).verdict).toBe('mismatch');       // different fps/duration
    const rewrapped = path.join(dir, 'A_25fps_10s.mkv'); (await import('node:child_process')).execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', fx.A!, '-c', 'copy', rewrapped]);
    const v = assessIdentity(ref, await probeMedia(rewrapped)); expect(v.verdict).toBe('likely'); expect(v.reasons[0]).toMatch(/confirm/);
    const sameNameOther = path.join(dir, 'sub'); fs.mkdirSync(sameNameOther); const imposter = path.join(sameNameOther, 'A_25fps_10s.mp4'); fs.copyFileSync(fx.H!, imposter);
    expect(assessIdentity(ref, await probeMedia(imposter)).verdict).toBe('mismatch');   // H is 6 s: duration differs although the file name matches
  }, 60_000);
});
