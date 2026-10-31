import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExportProgress, ExportReport } from '@fs/media-contracts';
import type { MediaRef, ProjectDoc } from '@fs/project-model';
import { candidatePaths } from '@fs/project-model';
import { ExportError, ExportPlan, ExportPreset, PRESET_H264_MP4, buildFfmpegArgs, planExport } from './plan.ts';
import { ContentOracle, validateExport } from './validate.ts';

export interface ExportRequest {
  sequenceId: string; dest: string; overwrite?: boolean; range?: { start: number; end: number }; preset?: ExportPreset;
  projectDir: string; signal?: AbortSignal; onProgress?: (p: ExportProgress) => void; oracle?: (plan: ExportPlan) => ContentOracle | undefined;
}

/** Resolve media files for a snapshot. Fails with the full list of missing/changed media before any encoding starts. */
export function resolveMedia(doc: ProjectDoc, ids: string[], projectDir: string): Record<string, string> {
  const out: Record<string, string> = {}; const missing: string[] = []; const changed: string[] = [];
  for (const id of ids) {
    const m: MediaRef = doc.mediaPool[id]!; const hit = candidatePaths(m.path, projectDir).find((p) => fs.existsSync(p));
    if (!hit) { missing.push(`${m.name} (${m.path.absolute})`); continue; }
    if (fs.statSync(hit).size !== m.fingerprint.size) { changed.push(`${m.name}: size ${fs.statSync(hit).size} != recorded ${m.fingerprint.size}`); continue; }
    out[id] = hit;
  }
  if (missing.length) throw new ExportError('MissingMedia', `missing media: ${missing.join('; ')}. Relink it first.`, { missing });
  if (changed.length) throw new ExportError('MediaChanged', `media files changed since import: ${changed.join('; ')}. Relink or re-import.`, { changed });
  return out;
}

/**
 * Export from an immutable snapshot (the ProjectDoc is deeply frozen by the command engine, so edits made while this runs cannot affect it).
 * Writes to a temp file next to the destination, validates it independently, and only then renames it into place.
 */
export async function exportSequence(snapshot: ProjectDoc, req: ExportRequest): Promise<ExportReport> {
  const preset = req.preset ?? PRESET_H264_MP4; const prog = (p: Partial<ExportProgress> & { phase: ExportProgress['phase'] }) => req.onProgress?.({ frame: 0, totalFrames: 0, fraction: 0, ...p });
  const checks: ExportReport['checks'] = []; let tmp = '';
  try {
    prog({ phase: 'preparing' });
    const ext = `.${preset.container}`; const dest = path.resolve(req.dest);
    if (!dest.toLowerCase().endsWith(ext)) throw new ExportError('DestinationInvalid', `destination must end with ${ext}`);
    if (!fs.existsSync(path.dirname(dest))) throw new ExportError('DestinationInvalid', `folder does not exist: ${path.dirname(dest)}`);
    if (fs.existsSync(dest) && !req.overwrite) throw new ExportError('DestinationExists', `${dest} already exists; choose another name or confirm overwrite`);
    const plan = planExport(snapshot, req.sequenceId, req.range); const paths = resolveMedia(snapshot, plan.mediaIds, req.projectDir);
    tmp = path.join(path.dirname(dest), `.${path.basename(dest, ext)}.fstudio-part${ext}`); fs.rmSync(tmp, { force: true });
    const args = buildFfmpegArgs(plan, paths, preset, tmp);
    prog({ phase: 'encoding', totalFrames: plan.frames });
    await new Promise<void>((resolve, reject) => {
      const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let err = ''; let buf = '';
      p.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
      p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = /^frame=(\d+)/.exec(line); if (m) prog({ phase: 'encoding', frame: +m[1]!, totalFrames: plan.frames, fraction: Math.min(1, +m[1]! / plan.frames) }); } });
      const onAbort = () => { p.kill('SIGKILL'); };
      if (req.signal?.aborted) onAbort(); req.signal?.addEventListener('abort', onAbort, { once: true });
      p.on('error', (e) => reject(new ExportError('EncoderFailed', `cannot start ffmpeg: ${e.message}`)));
      p.on('close', (code) => { req.signal?.removeEventListener('abort', onAbort); if (req.signal?.aborted) reject(new ExportError('Cancelled', 'export cancelled')); else if (code !== 0) reject(new ExportError('EncoderFailed', `ffmpeg exited with ${code}: ${err.trim().slice(-600)}`)); else resolve(); });
    });
    prog({ phase: 'validating', frame: plan.frames, totalFrames: plan.frames, fraction: 1 });
    checks.push(...(await validateExport(tmp, plan, req.oracle?.(plan))));
    if (checks.some((c) => !c.ok)) throw new ExportError('ValidationFailed', `export failed independent validation: ${checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ')}`);
    prog({ phase: 'finalizing', frame: plan.frames, totalFrames: plan.frames, fraction: 1 });
    if (fs.existsSync(dest) && !req.overwrite) throw new ExportError('DestinationExists', `${dest} appeared while exporting; not overwriting`);
    fs.renameSync(tmp, dest); tmp = ''; prog({ phase: 'done', frame: plan.frames, totalFrames: plan.frames, fraction: 1 });
    return { ok: true, output: dest, checks, warnings: plan.warnings, ffmpegCommand: ['ffmpeg', ...args.map((a) => (a.length > 400 ? `${a.slice(0, 400)}...` : a))] };
  } catch (e) {
    if (tmp) fs.rmSync(tmp, { force: true });
    const ee = e instanceof ExportError ? e : new ExportError('EncoderFailed', (e as Error).message);
    prog({ phase: ee.code === 'Cancelled' ? 'cancelled' : 'failed', message: ee.message });
    return { ok: false, checks: [...checks, { name: ee.code, ok: false, detail: ee.message }], warnings: [] };
  }
}
