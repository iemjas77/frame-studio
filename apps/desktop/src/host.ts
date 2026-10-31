/**
 * Engine host: owns the project session (command engine + journal), media services and export jobs.
 * The editor UI is a separate, untrusted client. Transport: HTTP on 127.0.0.1 with a per-launch token; JSON for state/commands,
 * binary JPEG for frames. No full-resolution frames ever travel as JSON.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { FPS, rate } from '@fs/timeline-model';
import { MediaRef, ProjectDoc, candidatePaths, makeProject, makeSequence } from '@fs/project-model';
import { CommandError, Command } from '@fs/command-engine';
import { ProjectSession } from '@fs/command-engine/node';
import { SequentialFrameSource, assessIdentity, decodeFrameJpeg, probeMedia, toMediaRef, waveformPeaks, runBounded } from '@fs/media-services';
import { MediaError } from '@fs/media-contracts';
import { exportSequence, ExportError } from '@fs/export-engine';
import { videoLayersAt } from '@fs/playback';
import type { ExportProgress, ExportReport } from '@fs/media-contracts';

export interface HostOptions { projectFile: string; staticDir?: string; token?: string; port?: number; newProjectName?: string }
export interface Job { id: string; kind: 'export'; label: string; progress: ExportProgress; report?: ExportReport; abort: AbortController; startedAt: number }
const MEDIA_EXT = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.avi', '.webm', '.mxf', '.mts', '.m2ts', '.wav', '.mp3', '.aac', '.m4a', '.flac', '.aif', '.aiff', '.ogg', '.opus']);
const MAX_IMPORT_FILES = 2000, MAX_DEPTH = 8, MAX_BODY = 1_000_000;

export async function startHost(opts: HostOptions) {
  const token = opts.token ?? randomBytes(24).toString('hex');
  const projectDir = path.dirname(path.resolve(opts.projectFile));
  const session = fs.existsSync(opts.projectFile) ? ProjectSession.open(opts.projectFile) : (() => {
    const p = makeProject(randomUUID(), opts.newProjectName ?? 'Untitled Project', new Date().toISOString());
    const s = ProjectSession.create(opts.projectFile, p);
    s.engine.execute({ type: 'sequence.create', sequence: makeSequence({ id: 'seq_' + randomUUID().slice(0, 8), name: 'Sequence 1', rate: FPS.f25, width: 1920, height: 1080 }) }, 'New sequence');
    s.save(); return s;
  })();
  const engine = session.engine;
  const jobs = new Map<string, Job>(); const sources = new Map<string, SequentialFrameSource>(); const latestGen = new Map<string, number>();
  let blackJpeg: Buffer | null = null;
  const log: string[] = [];

  const resolvePath = (m: MediaRef): string | null => candidatePaths(m.path, projectDir).find((p) => fs.existsSync(p)) ?? null;
  const mediaStatus = (doc: ProjectDoc) => Object.fromEntries(Object.values(doc.mediaPool).map((m) => {
    const p = resolvePath(m); if (!p) return [m.id, 'missing'];
    try { return [m.id, fs.statSync(p).size === m.fingerprint.size ? 'ok' : 'changed']; } catch { return [m.id, 'missing']; }
  }));
  const stateJson = () => ({ revision: engine.revision, dirty: session.dirty, canUndo: engine.canUndo, canRedo: engine.canRedo, undoLabel: engine.undoLabel, redoLabel: engine.redoLabel, gesture: engine.gestureActive,
    project: engine.state, mediaStatus: mediaStatus(engine.state), jobs: [...jobs.values()].map(jobJson), file: opts.projectFile, recovery: session.report });
  const jobJson = (j: Job) => ({ id: j.id, kind: j.kind, label: j.label, progress: j.progress, report: j.report, startedAt: j.startedAt });
  const sourceFor = (m: MediaRef): SequentialFrameSource => {
    const p = resolvePath(m); if (!p) throw new MediaError('NotFound', `media file missing: ${m.path.absolute}`);
    let s = sources.get(m.id + '|' + p); if (!s) { if (sources.size >= 4) { const [k, v] = sources.entries().next().value!; v.kill(); sources.delete(k); } s = new SequentialFrameSource(p, m.video!.rate, 640); sources.set(m.id + '|' + p, s); } return s;
  };
  const getBlack = async () => blackJpeg ??= (await runBounded('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], { timeoutMs: 10000, maxOutputBytes: 1_000_000 })).stdout;

  /* ---- import (files and folders; folders become nested bins) ---- */
  async function importPaths(paths: string[]) {
    const results: { path: string; ok: boolean; mediaId?: string; error?: string; warnings?: string[] }[] = [];
    const files: { file: string; bin: string | null }[] = []; let count = 0;
    const walk = (dir: string, parent: string | null, depth: number) => {
      if (depth > MAX_DEPTH) return;
      const binId = 'bin_' + randomUUID().slice(0, 8);
      engine.execute({ type: 'bin.create', bin: { id: binId, name: path.basename(dir) || dir, parentId: parent } }, 'Import folder');
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (count >= MAX_IMPORT_FILES) break; const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(full, binId, depth + 1); else if (e.isFile() && MEDIA_EXT.has(path.extname(e.name).toLowerCase())) { files.push({ file: full, bin: binId }); count++; }
      }
    };
    for (const p of paths) {
      if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) { results.push({ path: String(p), ok: false, error: 'path must be absolute' }); continue; }
      try { const st = fs.statSync(p); if (st.isDirectory()) walk(p, null, 0); else files.push({ file: p, bin: null }); } catch { results.push({ path: p, ok: false, error: 'not found' }); }
    }
    for (const f of files) {
      try {
        const dup = Object.values(engine.state.mediaPool).find((m) => resolvePath(m) === f.file); if (dup) { results.push({ path: f.file, ok: false, error: `already imported as ${dup.name}`, mediaId: dup.id }); continue; }
        const probe = await probeMedia(f.file); const id = 'media_' + randomUUID().slice(0, 8);
        engine.execute({ type: 'media.add', media: toMediaRef(probe, id, projectDir, f.bin) }, `Import ${path.basename(f.file)}`);
        results.push({ path: f.file, ok: true, mediaId: id, warnings: probe.warnings });
      } catch (e) { results.push({ path: f.file, ok: false, error: (e as Error).message }); }
    }
    return results;
  }

  async function relink(mediaId: string, file: string, confirmLikely: boolean) {
    const m = engine.state.mediaPool[mediaId]; if (!m) throw new CommandError('NotFound', 'media not found');
    if (!path.isAbsolute(file)) throw new CommandError('InvalidArgument', 'path must be absolute');
    const probe = await probeMedia(file); const v = assessIdentity(m, probe);
    if (v.verdict === 'mismatch') return { ok: false, verdict: v };
    if (v.verdict === 'likely' && !confirmLikely) return { ok: false, needsConfirmation: true, verdict: v };
    engine.execute({ type: 'media.update', mediaId, patch: { path: { absolute: file, relative: undefined }, fingerprint: probe.fingerprint } }, `Relink ${m.name}`);
    for (const k of [...sources.keys()]) if (k.startsWith(mediaId + '|')) { sources.get(k)!.kill(); sources.delete(k); }
    return { ok: true, verdict: v };
  }

  function startExport(body: any): Job {
    const id = 'job_' + randomUUID().slice(0, 8); const abort = new AbortController(); const snapshot = engine.state; // immutable snapshot
    const job: Job = { id, kind: 'export', label: `Export ${path.basename(String(body.dest))}`, progress: { phase: 'preparing', frame: 0, totalFrames: 0, fraction: 0 }, abort, startedAt: Date.now() };
    jobs.set(id, job);
    exportSequence(snapshot, { sequenceId: String(body.sequenceId), dest: String(body.dest), overwrite: body.overwrite === true, range: body.range, projectDir, signal: abort.signal, onProgress: (p) => { job.progress = p; } })
      .then((r) => { job.report = r; }).catch((e) => { job.report = { ok: false, checks: [{ name: 'internal', ok: false, detail: String(e) }], warnings: [] }; });
    return job;
  }

  /* ---- http ---- */
  const origin = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (res: http.ServerResponse, code: number, body: unknown, type = 'application/json', extra: Record<string, string> = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra }); res.end(buf);
  };
  const readBody = (req: http.IncomingMessage) => new Promise<any>((resolve, reject) => {
    let n = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { n += c.length; if (n > MAX_BODY) { reject(new CommandError('InvalidArgument', 'request body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new CommandError('InvalidArgument', 'invalid JSON')); } });
  });
  const CSP = "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const hostHdr = req.headers.host ?? ''; if (!/^127\.0\.0\.1:\d+$/.test(hostHdr) && !/^localhost:\d+$/.test(hostHdr)) return send(res, 403, { error: 'bad host' });
      if (req.headers.origin && req.headers.origin !== origin()) return send(res, 403, { error: 'cross-origin request refused' });
      if (url.pathname.startsWith('/api/')) {
        if ((req.headers['x-fs-token'] ?? url.searchParams.get('t')) !== token) return send(res, 401, { error: 'bad token' });
        return await api(req, res, url);
      }
      // static editor (token is checked when the page is requested so a stray local process cannot load it)
      if (!opts.staticDir) return send(res, 404, { error: 'no ui' });
      if (url.pathname === '/' && url.searchParams.get('t') !== token) return send(res, 401, 'token required', 'text/plain');
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, ''); const file = path.resolve(opts.staticDir, rel);
      if (!file.startsWith(path.resolve(opts.staticDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain');
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.map': 'application/json' };
      return send(res, 200, fs.readFileSync(file), types[path.extname(file)] ?? 'application/octet-stream', { 'content-security-policy': CSP, 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
    } catch (e) { return fail(res, e); }
  });
  const fail = (res: http.ServerResponse, e: unknown) => {
    if (res.headersSent) return res.end();
    if (e instanceof CommandError) return send(res, 400, { error: { code: e.code, message: e.message } });
    if (e instanceof MediaError) return send(res, e.code === 'NotFound' ? 404 : 422, { error: { code: e.code, message: e.message } });
    if (e instanceof ExportError) return send(res, 400, { error: { code: e.code, message: e.message } });
    log.push(String((e as Error)?.stack ?? e)); return send(res, 500, { error: { code: 'Internal', message: 'internal error' } });
  };

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const route = `${req.method} ${url.pathname}`; const q = url.searchParams; const num = (k: string, d?: number) => { const v = Number(q.get(k)); if (!Number.isFinite(v)) { if (d !== undefined) return d; throw new CommandError('InvalidArgument', `bad ${k}`); } return v; };
    const m = /^\/api\/(frame\/media|thumb|waveform)\/([\w-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const media = engine.state.mediaPool[m[2]!]; if (!media) return send(res, 404, { error: { code: 'NotFound', message: 'media not found' } });
      if (m[1] === 'waveform') { if (!media.audio) return send(res, 404, { error: { code: 'NotFound', message: 'no audio' } }); const p = resolvePath(media); if (!p) return send(res, 404, { error: { code: 'NotFound', message: 'missing' } }); return send(res, 200, await waveformPeaks(p, 600)); }
      if (!media.video) return send(res, 404, { error: { code: 'NotFound', message: 'no video' } });
      if (m[1] === 'thumb') { const p = resolvePath(media); if (!p) return send(res, 404, { error: { code: 'NotFound', message: 'missing' } }); return send(res, 200, await decodeFrameJpeg(p, Math.floor(media.video.duration.ticks * 0.1), media.video.rate, 160), 'image/jpeg'); }
      const frame = Math.max(0, Math.min(media.video.duration.ticks - 1, num('frame'))); const gen = num('g'); const mon = q.get('mon') ?? 'source';
      if (gen < (latestGen.get(mon) ?? -1)) return send(res, 409, { error: { code: 'Stale', message: 'superseded by a newer request' } });
      latestGen.set(mon, gen); const jpg = await sourceFor(media).get(frame);
      if (gen < (latestGen.get(mon) ?? -1)) return send(res, 409, { error: { code: 'Stale', message: 'superseded by a newer request' } });
      return send(res, 200, jpg, 'image/jpeg', { 'x-fs-frame': String(frame) });
    }
    switch (route) {
      case 'GET /api/state': return send(res, 200, stateJson());
      case 'GET /api/frame/program': {
        const doc = engine.state; const seq = doc.sequences[q.get('seq') ?? doc.activeSequenceId ?? '']; if (!seq) return send(res, 404, { error: { code: 'NotFound', message: 'sequence not found' } });
        const frame = Math.max(0, num('frame')); const gen = num('g'); if (gen < (latestGen.get('program') ?? -1)) return send(res, 409, { error: { code: 'Stale', message: 'superseded' } }); latestGen.set('program', gen);
        const top = videoLayersAt(doc, seq, frame)[0];
        const jpg = top ? await sourceFor(doc.mediaPool[top.mediaId]!).get(top.sourceFrame) : await getBlack();
        if (gen < (latestGen.get('program') ?? -1)) return send(res, 409, { error: { code: 'Stale', message: 'superseded' } });
        return send(res, 200, jpg, 'image/jpeg', { 'x-fs-frame': String(frame), 'x-fs-source': top ? `${top.mediaId}:${top.sourceFrame}` : 'none', 'x-fs-revision': String(engine.revision) });
      }
      case 'POST /api/command': { const b = await readBody(req); engine.execute(b.command as Command, typeof b.label === 'string' ? b.label : undefined); return send(res, 200, stateJson()); }
      case 'POST /api/gesture': {
        const b = await readBody(req);
        if (b.op === 'begin') engine.beginGesture(String(b.key), String(b.label ?? b.key)); else if (b.op === 'update') engine.updateGesture(b.command as Command);
        else if (b.op === 'commit') engine.commitGesture(); else if (b.op === 'cancel') engine.cancelGesture(); else throw new CommandError('InvalidArgument', 'bad gesture op');
        return send(res, 200, stateJson());
      }
      case 'POST /api/undo': engine.undo(); return send(res, 200, stateJson());
      case 'POST /api/redo': engine.redo(); return send(res, 200, stateJson());
      case 'POST /api/save': session.save(); return send(res, 200, stateJson());
      case 'POST /api/import': { const b = await readBody(req); const results = await importPaths(Array.isArray(b.paths) ? b.paths.slice(0, 500) : []); return send(res, 200, { results, state: stateJson() }); }
      case 'POST /api/relink': { const b = await readBody(req); const r = await relink(String(b.mediaId), String(b.path), b.confirmLikely === true); return send(res, 200, { ...r, state: stateJson() }); }
      case 'POST /api/export': { const b = await readBody(req); const j = startExport(b); return send(res, 200, { job: jobJson(j) }); }
      case 'GET /api/jobs': return send(res, 200, { jobs: [...jobs.values()].map(jobJson) });
      default: {
        const c = /^POST \/api\/jobs\/([\w-]+)\/cancel$/.exec(route); if (c) { jobs.get(c[1]!)?.abort.abort(); return send(res, 200, { ok: true }); }
        return send(res, 404, { error: { code: 'NotFound', message: 'no such route' } });
      }
    }
  }

  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const url = `${origin()}/?t=${token}`;
  return {
    url, token, origin: origin(), session, engine, log,
    autosave: () => session.autosave(),
    close: async () => { for (const s of sources.values()) s.kill(); for (const j of jobs.values()) j.abort.abort(); await new Promise<void>((r) => server.close(() => r())); },
  };
}
void rate;
