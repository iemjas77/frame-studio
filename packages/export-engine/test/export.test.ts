import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs'; import * as os from 'node:os'; import * as path from 'node:path';
import { FPS, time } from '@fs/timeline-model';
import { makeProject, makeSequence } from '@fs/project-model';
import { CommandEngine } from '@fs/command-engine';
import { videoLayersAt } from '@fs/playback';
import { ensureFixtures, probeMedia, toMediaRef, readFrameIdentity, runBounded } from '@fs/media-services';
import { exportSequence, planExport, buildFfmpegArgs, PRESET_H264_MP4, type ContentOracle, type ExportPlan } from '../src/index.ts';

let dir: string; let fx: Record<string, string>; let out: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-exp-')); fx = ensureFixtures(path.join(dir, 'media')); out = path.join(dir, 'out'); fs.mkdirSync(out); }, 120_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function project() {
  let n = 0; const e = new CommandEngine(makeProject('p', 'P', '2026-01-01T00:00:00.000Z'), { idSource: () => `t${++n}` });
  for (const [id, key] of [['A', 'A'], ['H', 'H']] as const) e.execute({ type: 'media.add', media: toMediaRef(await probeMedia(fx[key]!), id, dir) });
  e.execute({ type: 'sequence.create', sequence: makeSequence({ id: 's', name: 'Seq', rate: FPS.f25, width: 640, height: 360 }) });
  return e;
}
const oracleFor = (doc: any) => (plan: ExportPlan): ContentOracle => {
  const frames = [0, 1, 29, 30, 31, 50, 69, 70, 71, 99, 100, 101, 115, plan.frames - 1].filter((f) => f < plan.frames).map((f) => {
    const top = videoLayersAt(doc, plan.seq, plan.start + f)[0]; return { outFrame: f, expect: top ? top.sourceFrame : null };
  });
  return { frames, read: (g, w) => readFrameIdentity(g, w, 360) };
};
/** dominant frequency by zero crossings over a window of mono left channel */
async function tone(file: string, fromSec: number, toSec: number): Promise<{ hz: number; rms: number }> {
  const { stdout } = await runBounded('ffmpeg', ['-v', 'error', '-nostdin', '-ss', String(fromSec), '-t', String(toSec - fromSec), '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'], { timeoutMs: 60_000, maxOutputBytes: 50_000_000 });
  const n = stdout.length / 2; let cr = 0, prev = 0, sq = 0; for (let i = 0; i < n; i++) { const v = stdout.readInt16LE(i * 2); if (prev < 0 && v >= 0) cr++; prev = v; sq += v * v; }
  return { hz: cr / (n / 48000), rms: Math.sqrt(sq / n) / 32768 };
}

describe('export (acceptance 3 subset: edit -> export -> independent inspection)', () => {
  it('exports an edited multi-track timeline and passes every independent check, with correct picture and sound per segment', async () => {
    const e = await project();
    e.execute({ type: 'edit.insert', sequenceId: 's', mediaId: 'A', time: 0, sourceIn: time(50, FPS.f25), sourceOut: time(150, FPS.f25) });           // A 0..100  (src 50..150)
    e.execute({ type: 'edit.insert', sequenceId: 's', mediaId: 'H', time: 30, sourceIn: time(0, FPS.f25), sourceOut: time(40, FPS.f25) });            // A 0..30, H 30..70, A' 70..140
    const a2 = e.state.sequences.s!.videoTracks[0]!.clips[2]!; e.execute({ type: 'edit.trim', sequenceId: 's', clipId: a2.id, edge: 'end', toTime: 130 });   // A' 70..130
    e.execute({ type: 'edit.overwrite', sequenceId: 's', mediaId: 'H', time: 100, sourceIn: time(100, FPS.f25), sourceOut: time(130, FPS.f25), targets: { video: 's_V2' }, only: 'video' }); // V2 over 100..130
    const snap = e.state; const dest = path.join(out, 'cut.mp4'); const phases: string[] = [];
    const r = await exportSequence(snap, { sequenceId: 's', dest, projectDir: dir, oracle: oracleFor(snap), onProgress: (p) => { if (!phases.includes(p.phase)) phases.push(p.phase); } });
    expect(r.checks.filter((c) => !c.ok)).toEqual([]); expect(r.ok).toBe(true); expect(fs.existsSync(dest)).toBe(true); expect(phases).toEqual(['preparing', 'encoding', 'validating', 'finalizing', 'done']);
    expect(fs.readdirSync(out).filter((n) => n.includes('fstudio-part'))).toEqual([]);
    // independent audio check: 440 Hz | 1000 Hz | 440 Hz at the edit points
    const t = async (a: number, b: number) => tone(dest, a, b);
    const s1 = await t(0.1, 1.1), s2 = await t(1.4, 2.7), s3 = await t(3.1, 5.1);
    expect(Math.abs(s1.hz - 440)).toBeLessThan(8); expect(Math.abs(s2.hz - 1000)).toBeLessThan(15); expect(Math.abs(s3.hz - 440)).toBeLessThan(8); expect(s1.rms).toBeGreaterThan(0.02);
    expect(r.checks.find((c) => c.name === 'visual content at sampled frames')!.detail).toMatch(/matched/);
  }, 180_000);

  it('gaps export as black picture and silence, and the track structure is preserved', async () => {
    const e = await project(); e.execute({ type: 'edit.overwrite', sequenceId: 's', mediaId: 'A', time: 25, sourceIn: time(10, FPS.f25), sourceOut: time(60, FPS.f25) });
    const snap = e.state; const dest = path.join(out, 'gap.mp4');
    const r = await exportSequence(snap, { sequenceId: 's', dest, projectDir: dir, range: { start: 0, end: 75 }, oracle: (p) => ({ frames: [0, 10, 24, 25, 26, 74].map((f) => ({ outFrame: f, expect: f < 25 ? null : f - 25 + 10 })), read: (g, w) => readFrameIdentity(g, w, 360) }) });
    expect(r.checks.filter((c) => !c.ok)).toEqual([]); const sil = await tone(dest, 0.1, 0.9); expect(sil.rms).toBeLessThan(0.002); expect((await tone(dest, 1.2, 2.5)).hz).toBeGreaterThan(420);
  }, 120_000);

  it('uses an immutable snapshot: edits made after the snapshot do not change the output', async () => {
    const e = await project(); e.execute({ type: 'edit.insert', sequenceId: 's', mediaId: 'A', time: 0, sourceIn: time(0, FPS.f25), sourceOut: time(50, FPS.f25) }); const snap = e.state;
    const dest = path.join(out, 'snap.mp4'); const p = exportSequence(snap, { sequenceId: 's', dest, projectDir: dir });
    e.execute({ type: 'edit.split', sequenceId: 's', time: 10, allTracks: true }); e.execute({ type: 'edit.rippleDelete', sequenceId: 's', clipIds: [e.state.sequences.s!.videoTracks[0]!.clips[0]!.id] });
    const r = await p; expect(r.ok).toBe(true); expect(r.checks.find((c) => c.name === 'frame count')!.detail).toMatch(/^50 decoded/);
  }, 120_000);

  it('never overwrites silently; overwrite requires explicit consent; destination validated', async () => {
    const e = await project(); e.execute({ type: 'edit.insert', sequenceId: 's', mediaId: 'A', time: 0, sourceIn: time(0, FPS.f25), sourceOut: time(25, FPS.f25) });
    const dest = path.join(out, 'exists.mp4'); fs.writeFileSync(dest, 'precious');
    const r = await exportSequence(e.state, { sequenceId: 's', dest, projectDir: dir }); expect(r.ok).toBe(false); expect(r.checks.at(-1)!.name).toBe('DestinationExists'); expect(fs.readFileSync(dest, 'utf8')).toBe('precious');
    expect((await exportSequence(e.state, { sequenceId: 's', dest: path.join(out, 'x.avi'), projectDir: dir })).checks.at(-1)!.name).toBe('DestinationInvalid');
    expect((await exportSequence(e.state, { sequenceId: 's', dest, projectDir: dir, overwrite: true })).ok).toBe(true); expect(fs.statSync(dest).size).toBeGreaterThan(1000);
  }, 120_000);

  it('missing or changed media is reported before encoding; no output or temp files are left behind', async () => {
    const e = await project(); e.execute({ type: 'edit.insert', sequenceId: 's', mediaId: 'A', time: 0, sourceIn: time(0, FPS.f25), sourceOut: time(25, FPS.f25) });
    const bad = structuredClone(e.state); bad.mediaPool.A!.path = { absolute: '/nowhere/A.mp4' };
    const r = await exportSequence(bad, { sequenceId: 's', dest: path.join(out, 'm.mp4'), projectDir: '/nowhere' }); expect(r.ok).toBe(false); expect(r.checks.at(-1)).toMatchObject({ name: 'MissingMedia' }); expect(r.checks.at(-1)!.detail).toMatch(/Relink/);
    const chg = structuredClone(e.state); chg.mediaPool.A!.fingerprint.size += 1; expect((await exportSequence(chg, { sequenceId: 's', dest: path.join(out, 'm2.mp4'), projectDir: dir })).checks.at(-1)!.name).toBe('MediaChanged');
    expect(fs.existsSync(path.join(out, 'm.mp4'))).toBe(false);
  }, 60_000);

  it('cancellation stops ffmpeg, removes the temp file and creates no destination', async () => {
    const e = await project(); e.execute({ type: 'edit.insert', sequenceId: 's', mediaId: 'A', time: 0 });
    const ac = new AbortController(); const dest = path.join(out, 'cancel.mp4'); const p = exportSequence(e.state, { sequenceId: 's', dest, projectDir: dir, signal: ac.signal, onProgress: (x) => { if (x.phase === 'encoding' && x.frame > 5) ac.abort(); } });
    const r = await p; expect(r.ok).toBe(false); expect(r.checks.at(-1)!.name).toBe('Cancelled'); expect(fs.existsSync(dest)).toBe(false); expect(fs.readdirSync(out).filter((n) => n.includes('cancel') || n.includes('fstudio-part'))).toEqual([]);
  }, 120_000);

  it('a corrupted result fails validation and is not finalized (validator is independent of ffmpeg exit code)', async () => {
    const { validateExport } = await import('../src/index.ts'); const e = await project(); e.execute({ type: 'edit.insert', sequenceId: 's', mediaId: 'A', time: 0, sourceIn: time(0, FPS.f25), sourceOut: time(50, FPS.f25) });
    const dest = path.join(out, 'good.mp4'); expect((await exportSequence(e.state, { sequenceId: 's', dest, projectDir: dir })).ok).toBe(true);
    const bytes = fs.readFileSync(dest); const dam = path.join(out, 'damaged.mp4'); fs.writeFileSync(dam, Buffer.concat([bytes.subarray(0, bytes.length - 6000), Buffer.alloc(0)]));
    const plan = planExport(e.state, 's'); const checks = await validateExport(dam, plan); expect(checks.some((c) => !c.ok)).toBe(true);
  }, 120_000);

  it('rejects unsupported content explicitly (speed change) instead of exporting something different', async () => {
    const e = await project(); e.execute({ type: 'edit.insert', sequenceId: 's', mediaId: 'A', time: 0, sourceIn: time(0, FPS.f25), sourceOut: time(50, FPS.f25) });
    const doc = structuredClone(e.state); doc.sequences.s!.videoTracks[0]!.clips[0]!.speed = { num: 2, den: 1 };
    expect(() => planExport(doc, 's')).toThrow(/speed/); void buildFfmpegArgs; void PRESET_H264_MP4;
  });
});
