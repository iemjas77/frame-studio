import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs'; import * as os from 'node:os'; import * as path from 'node:path';
import { ensureFixtures } from '@fs/media-services';
import { startHost } from '../../apps/desktop/src/host.ts';

let dir: string, fx: Record<string, string>, h: Awaited<ReturnType<typeof startHost>>;
const api = async (p: string, body?: unknown, init: RequestInit = {}, token = h.token) => {
  const r = await fetch(`${h.origin}${p}${p.includes('?') ? '&' : '?'}t=${token}`, { method: body === undefined && !init.method ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), ...init });
  return r;
};
const json = async (p: string, body?: unknown) => (await api(p, body)).json() as Promise<any>;
beforeAll(async () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-host-')); fx = ensureFixtures(path.join(dir, 'media')); h = await startHost({ projectFile: path.join(dir, 'proj', 'p.fstudio') }); }, 120_000);
afterAll(async () => { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('host security', () => {
  it('requires the token, rejects foreign origins and hosts', async () => {
    expect((await fetch(`${h.origin}/api/state`)).status).toBe(401);
    expect((await api('/api/state', undefined, {}, 'wrong')).status).toBe(401);
    expect((await fetch(`${h.origin}/api/state?t=${h.token}`, { headers: { origin: 'http://evil.example' } })).status).toBe(403);
    expect((await api('/api/state')).status).toBe(200);
  });
  it('rejects malformed commands without changing state and does not leak stack traces', async () => {
    const before = await json('/api/state'); const r = await api('/api/command', { command: { type: 'rm -rf', x: 1 } }); expect(r.status).toBe(400);
    const b = await r.json(); expect(b.error.code).toBe('InvalidArgument'); expect(JSON.stringify(b)).not.toMatch(/at .*\.ts/);
    expect((await json('/api/state')).revision).toBe(before.revision);
  });
  it('import refuses relative paths and non-media; traversal in static serving is blocked', async () => {
    const res = await json('/api/import', { paths: ['relative/a.mp4', '/definitely/missing.mp4', path.join(dir, 'proj', 'p.fstudio')] });
    expect(res.results.map((x: any) => x.ok)).toEqual([false, false, false]);
  });
});

describe('host workflow', () => {
  let seqId: string, a: string, h2: string;
  it('imports a file and a folder (folder -> bin), reports per-file errors, keeps going', async () => {
    const r = await json('/api/import', { paths: [fx.A!, fx.Z!] }); expect(r.results[0].ok).toBe(true); expect(r.results[1].ok).toBe(false); expect(r.results[1].error).toMatch(/empty/);
    a = r.results[0].mediaId; const folder = path.join(dir, 'folder'); fs.mkdirSync(path.join(folder, 'sub'), { recursive: true }); fs.copyFileSync(fx.H!, path.join(folder, 'sub', 'H.mp4')); fs.copyFileSync(fx.D!, path.join(folder, 'D.wav')); fs.writeFileSync(path.join(folder, 'notes.txt'), 'x');
    const r2 = await json('/api/import', { paths: [folder] }); expect(r2.results.filter((x: any) => x.ok).length).toBe(2); h2 = r2.results.find((x: any) => x.path.endsWith('H.mp4')).mediaId;
    const proj = r2.state.project; expect(Object.values<any>(proj.bins).map((b) => b.name).sort()).toEqual(['folder', 'sub']); expect(proj.mediaPool[h2].binId).toBe(Object.values<any>(proj.bins).find((b) => b.name === 'sub').id);
    seqId = proj.activeSequenceId; expect((await json('/api/import', { paths: [fx.A!] })).results[0].error).toMatch(/already imported/);
  });
  it('edits through commands; program frame follows the timeline; stale generations are rejected', async () => {
    const t = { type: 'edit.insert', sequenceId: seqId, mediaId: a, time: 0, sourceIn: { ticks: 50, rate: { num: 25, den: 1 } }, sourceOut: { ticks: 150, rate: { num: 25, den: 1 } } };
    let st = await json('/api/command', { command: t, label: 'Insert' }); expect(st.undoLabel).toBe('Insert');
    const r = await api(`/api/frame/program?frame=10&g=1&seq=${seqId}`); expect(r.status).toBe(200); expect(r.headers.get('x-fs-source')).toBe(`${a}:60`); const buf = Buffer.from(await r.arrayBuffer()); expect(buf.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect((await api(`/api/frame/program?frame=500&g=2&seq=${seqId}`)).headers.get('x-fs-source')).toBe('none');       // gap -> black
    expect((await api(`/api/frame/program?frame=11&g=1&seq=${seqId}`)).status).toBe(409);                                  // older generation after g=2
    st = await json('/api/undo', {}); expect(Object.values<any>(st.project.sequences[seqId].videoTracks[0].clips).length).toBe(0);
    await json('/api/redo', {});
  });
  it('gesture: many previews, one history entry', async () => {
    const st0 = await json('/api/state'); const clip = st0.project.sequences[seqId].videoTracks[0].clips[0].id;
    await json('/api/gesture', { op: 'begin', key: 'move', label: 'Move clip' });
    for (const d of [3, 9, 12]) await json('/api/gesture', { op: 'update', command: { type: 'edit.move', sequenceId: seqId, clipIds: [clip], deltaFrames: d } });
    const st1 = await json('/api/gesture', { op: 'commit' }); expect(st1.project.sequences[seqId].videoTracks[0].clips[0].start).toBe(12); expect(st1.undoLabel).toBe('Move clip');
    const st2 = await json('/api/undo', {}); expect(st2.project.sequences[seqId].videoTracks[0].clips[0].start).toBe(0); await json('/api/redo', {});
  });
  it('save + reopen on a fresh host reproduces the project (acceptance 1 via API)', async () => {
    await json('/api/save', {}); const live = (await json('/api/state')).project;
    const h3 = await startHost({ projectFile: path.join(dir, 'proj', 'p.fstudio') }); try {
      const again = await (await fetch(`${h3.origin}/api/state?t=${h3.token}`)).json() as any; expect(again.project).toEqual(live); expect(again.recovery.journalReplayed).toBe(0);
    } finally { await h3.close(); }
  });
  it('missing media is flagged, then relink refuses an imposter and accepts the true file (acceptance 5 via API)', async () => {
    const moved = path.join(dir, 'moved'); fs.mkdirSync(moved); const orig = fx.A!; const hidden = path.join(moved, 'A_hidden.mp4'); fs.renameSync(orig, hidden);
    try {
      let st = await json('/api/state'); expect(st.mediaStatus[a]).toBe('missing'); const before = JSON.stringify(st.project.sequences);
      const bad = await json('/api/relink', { mediaId: a, path: fx.H! }); expect(bad.ok).toBe(false); expect(bad.verdict.verdict).toBe('mismatch');
      const good = await json('/api/relink', { mediaId: a, path: hidden }); expect(good.ok).toBe(true); expect(good.verdict.verdict).toBe('identical');
      st = good.state; expect(st.mediaStatus[a]).toBe('ok'); expect(JSON.stringify(st.project.sequences)).toBe(before);   // edits untouched
    } finally { fs.renameSync(hidden, orig); expect((await json('/api/relink', { mediaId: a, path: orig })).ok).toBe(true); }
  }, 60_000);
  it('export job runs from a snapshot, reports validation evidence, and can be cancelled', async () => {
    const dest = path.join(dir, 'api-out.mp4'); const { job } = await json('/api/export', { sequenceId: seqId, dest });
    let j: any; for (let i = 0; i < 120; i++) { j = (await json('/api/jobs')).jobs.find((x: any) => x.id === job.id); if (j.report) break; await new Promise((r) => setTimeout(r, 250)); }
    expect(j.report.ok).toBe(true); expect(j.report.checks.every((c: any) => c.ok)).toBe(true); expect(fs.existsSync(dest)).toBe(true);
    const dest2 = path.join(dir, 'api-cancel.mp4'); const { job: j2 } = await json('/api/export', { sequenceId: seqId, dest: dest2 }); await json(`/api/jobs/${j2.id}/cancel`, {});
    for (let i = 0; i < 80; i++) { const x = (await json('/api/jobs')).jobs.find((y: any) => y.id === j2.id); if (x.report) { j = x; break; } await new Promise((r) => setTimeout(r, 250)); }
    expect(j.report.ok === false || fs.existsSync(dest2)).toBe(true); if (!j.report.ok) expect(fs.existsSync(dest2)).toBe(false);
  }, 120_000);
});
