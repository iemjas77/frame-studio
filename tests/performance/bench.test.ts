/** Baselines, not claims: numbers depend on this machine (recorded in the output JSON). Assertions are deliberately loose regression guards. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs'; import * as os from 'node:os'; import * as path from 'node:path';
import { FPS, time } from '@fs/timeline-model';
import { makeProject, makeSequence } from '@fs/project-model';
import { serializeProject, parseProject } from '@fs/project-model/node';
import { CommandEngine } from '@fs/command-engine';
import { ensureFixtures, probeMedia, toMediaRef, SequentialFrameSource, decodeFrameJpeg } from '@fs/media-services';
import { exportSequence } from '@fs/export-engine';
import { startHost } from '../../apps/desktop/src/host.ts';

const out: Record<string, unknown> = { machine: { cpu: os.cpus()[0]!.model, cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30), node: process.version, os: `${os.type()} ${os.release()}`, gpu: 'none (cloud container)', note: 'software only; fixtures are 640x360 synthetic H.264' } };
const stats = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return { n: s.length, p50: +s[Math.floor(s.length * 0.5)]!.toFixed(2), p95: +s[Math.floor(s.length * 0.95)]!.toFixed(2), max: +s.at(-1)!.toFixed(2) }; };
let dir: string, fx: Record<string, string>;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-perf-')); fx = ensureFixtures(path.join(dir, 'media')); }, 120_000);
afterAll(() => { fs.mkdirSync('test-results', { recursive: true }); fs.writeFileSync('test-results/benchmarks.json', JSON.stringify(out, null, 1)); fs.rmSync(dir, { recursive: true, force: true }); });

describe('benchmarks', () => {
  for (const clipsN of [200, 2000]) it(`command latency with ${clipsN} clips per video+audio track (undo history on)`, async () => {
    let n = 0; const e = new CommandEngine(makeProject('p', 'p', 'x'), { idSource: () => `t${++n}` });
    e.execute({ type: 'media.add', media: toMediaRef(await probeMedia(fx.A!), 'A', dir) }); e.execute({ type: 'sequence.create', sequence: makeSequence({ id: 's', name: 's', rate: FPS.f25 }) });
    const t0 = performance.now(); let t = 0; for (let i = 0; i < clipsN; i++) { e.execute({ type: 'edit.overwrite', sequenceId: 's', mediaId: 'A', time: t, sourceIn: time(0, FPS.f25), sourceOut: time(10, FPS.f25) }); t += 10; }
    const build = performance.now() - t0; const ins: number[] = [], spl: number[] = [], rip: number[] = [];
    for (let i = 0; i < 20; i++) { let s = performance.now(); e.execute({ type: 'edit.split', sequenceId: 's', time: 5 + 10 * Math.floor(clipsN / 2) + i * 10 * 3, allTracks: true }); spl.push(performance.now() - s); }
    for (let i = 0; i < 20; i++) { let s = performance.now(); e.execute({ type: 'edit.insert', sequenceId: 's', mediaId: 'A', time: 3, sourceIn: time(0, FPS.f25), sourceOut: time(10, FPS.f25) }); ins.push(performance.now() - s); }
    for (let i = 0; i < 20; i++) { let s = performance.now(); e.execute({ type: 'edit.rippleDelete', sequenceId: 's', clipIds: [e.state.sequences.s!.videoTracks[0]!.clips[1]!.id] }); rip.push(performance.now() - s); }
    const ser = performance.now(); const text = serializeProject(e.state, 'bench'); const serMs = performance.now() - ser; const par = performance.now(); parseProject(text); const parMs = performance.now() - par;
    const u: number[] = []; for (let i = 0; i < 20; i++) { const s = performance.now(); e.undo(); u.push(performance.now() - s); }
    out[`clips_${clipsN}`] = { buildMsTotal: +build.toFixed(0), insertMs: stats(ins), splitMs: stats(spl), rippleDeleteMs: stats(rip), undoMs: stats(u), serializeMs: +serMs.toFixed(1), parseValidateMs: +parMs.toFixed(1), fileKB: Math.round(text.length / 1024) };
    expect(stats(ins).p95).toBeLessThan(clipsN > 1000 ? 1500 : 300);
  }, 300_000);

  it('seek and sequential decode latency (reference decoder: ffmpeg subprocess)', async () => {
    const cold: number[] = []; for (const k of [0, 120, 40, 200, 77]) { const s = performance.now(); await decodeFrameJpeg(fx.A!, k, FPS.f25, 640); cold.push(performance.now() - s); }
    const src = new SequentialFrameSource(fx.C!, FPS.f29_97, 640); const first = performance.now(); await src.get(100); const startup = performance.now() - first; const seq: number[] = [];
    let prev = performance.now(); for (let k = 101; k < 161; k++) { await src.get(k); const now = performance.now(); seq.push(now - prev); prev = now; } const seeks: number[] = [];
    for (const k in [10, 190, 50, 150]) { const s = performance.now(); await src.get([10, 190, 50, 150][+k]!); seeks.push(performance.now() - s); } src.kill();
    out.decode = { oneShotColdSeekMs: stats(cold), sequentialStartupMs: +startup.toFixed(1), sequentialNextFrameMs: stats(seq), sequentialRestartSeekMs: stats(seeks), clip: 'C: 640x360 long-GOP B-frames 29.97' };
    expect(stats(seq).p95).toBeLessThan(200);
  }, 120_000);

  it('program-monitor frame API latency through the host (HTTP + decode + JPEG)', async () => {
    const h = await startHost({ projectFile: path.join(dir, 'p', 'p.fstudio') }); try {
      const j = async (p: string, b?: unknown) => (await fetch(`${h.origin}${p}?t=${h.token}`, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json() as Promise<any>;
      const r = await j('/api/import', { paths: [fx.A!] }); const id = r.results[0].mediaId; const seq = r.state.project.activeSequenceId;
      await j('/api/command', { command: { type: 'edit.insert', sequenceId: seq, mediaId: id, time: 0 } });
      const lat: number[] = []; for (let f = 0; f < 80; f++) { const s = performance.now(); const x = await fetch(`${h.origin}/api/frame/program?frame=${f}&g=${f + 1}&seq=${seq}&t=${h.token}`); await x.arrayBuffer(); lat.push(performance.now() - s); }
      const rnd: number[] = []; for (const [i, f] of [200, 30, 150, 60, 220].entries()) { const s = performance.now(); const x = await fetch(`${h.origin}/api/frame/program?frame=${f}&g=${1000 + i}&seq=${seq}&t=${h.token}`); await x.arrayBuffer(); rnd.push(performance.now() - s); }
      out.hostFrameApi = { sequentialMs: stats(lat), randomSeekMs: stats(rnd), achievableFpsSequential: +(1000 / (lat.reduce((a, b) => a + b, 0) / lat.length)).toFixed(1) };
    } finally { await h.close(); }
  }, 120_000);

  it('export throughput (640x360, H.264 veryfast crf18, includes independent validation)', async () => {
    let n = 0; const e = new CommandEngine(makeProject('p', 'p', 'x'), { idSource: () => `t${++n}` });
    e.execute({ type: 'media.add', media: toMediaRef(await probeMedia(fx.A!), 'A', dir) }); e.execute({ type: 'sequence.create', sequence: makeSequence({ id: 's', name: 's', rate: FPS.f25, width: 640, height: 360 }) });
    for (let i = 0; i < 6; i++) e.execute({ type: 'edit.overwrite', sequenceId: 's', mediaId: 'A', time: i * 50, sourceIn: time(i * 20, FPS.f25), sourceOut: time(i * 20 + 50, FPS.f25) });
    const s = performance.now(); const r = await exportSequence(e.state, { sequenceId: 's', dest: path.join(dir, 'bench.mp4'), projectDir: dir }); const ms = performance.now() - s;
    out.export = { frames: 300, seconds: +(ms / 1000).toFixed(2), fpsIncludingValidation: +(300 / (ms / 1000)).toFixed(1), clips: 6, ok: r.ok }; expect(r.ok).toBe(true);
  }, 120_000);
});
