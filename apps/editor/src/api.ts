import type { ProjectDoc } from '@fs/project-model';
import type { Command } from '@fs/command-engine';
import type { ExportProgress, ExportReport } from '@fs/media-contracts';

export interface JobInfo { id: string; label: string; progress: ExportProgress; report?: ExportReport }
export interface Snapshot {
  revision: number; dirty: boolean; canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null; gesture: boolean;
  project: ProjectDoc; mediaStatus: Record<string, 'ok' | 'missing' | 'changed'>; jobs: JobInfo[]; file: string;
  recovery: { source: string; journalReplayed: number; journalDropped: boolean; journalSkippedReason?: string };
}
export class ApiError extends Error { constructor(readonly code: string, message: string) { super(message); } }

const params = new URLSearchParams(location.search);
const TOKEN = params.get('t') ?? '';
if (TOKEN) history.replaceState(null, '', location.pathname); // keep the token out of the visible URL / history

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch(path, { method, headers: { 'x-fs-token': TOKEN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
  if (!r.ok) { let e: any = {}; try { e = (await r.json()).error ?? {}; } catch { /* ignore */ } throw new ApiError(e.code ?? String(r.status), e.message ?? r.statusText); }
  return r.json() as Promise<T>;
}
export const api = {
  state: () => call<Snapshot>('GET', '/api/state'),
  command: (command: Command, label?: string) => call<Snapshot>('POST', '/api/command', { command, label }),
  gesture: (op: 'begin' | 'update' | 'commit' | 'cancel', extra: { key?: string; label?: string; command?: Command } = {}) => call<Snapshot>('POST', '/api/gesture', { op, ...extra }),
  undo: () => call<Snapshot>('POST', '/api/undo', {}), redo: () => call<Snapshot>('POST', '/api/redo', {}), save: () => call<Snapshot>('POST', '/api/save', {}),
  import: (paths: string[]) => call<{ results: { path: string; ok: boolean; error?: string; warnings?: string[] }[]; state: Snapshot }>('POST', '/api/import', { paths }),
  relink: (mediaId: string, path: string, confirmLikely = false) => call<{ ok: boolean; needsConfirmation?: boolean; verdict: { verdict: string; reasons: string[] }; state: Snapshot }>('POST', '/api/relink', { mediaId, path, confirmLikely }),
  exportSeq: (sequenceId: string, dest: string, overwrite: boolean) => call<{ job: JobInfo }>('POST', '/api/export', { sequenceId, dest, overwrite }),
  cancelJob: (id: string) => call<{ ok: boolean }>('POST', `/api/jobs/${id}/cancel`, {}),
  waveform: (mediaId: string) => call<{ peaks: number[]; durationSec: number }>('GET', `/api/waveform/${mediaId}`),
  frameUrl: (kind: 'media' | 'program', id: string, frame: number, gen: number, mon: string) =>
    kind === 'media' ? `/api/frame/media/${id}?frame=${frame}&g=${gen}&mon=${mon}&t=${TOKEN}` : `/api/frame/program?frame=${frame}&g=${gen}&seq=${id}&t=${TOKEN}`,
  thumbUrl: (mediaId: string) => `/api/thumb/${mediaId}?t=${TOKEN}`,
};

/** Fetch a JPEG frame; resolves null when superseded (409) or aborted. Never decodes in the main thread beyond createImageBitmap. */
export async function fetchFrame(url: string, signal: AbortSignal): Promise<{ bitmap: ImageBitmap; source: string | null } | null> {
  try {
    const r = await fetch(url, { signal, headers: { 'x-fs-token': TOKEN } });
    if (r.status === 409) return null; if (!r.ok) throw new ApiError(String(r.status), 'frame unavailable');
    return { bitmap: await createImageBitmap(await r.blob()), source: r.headers.get('x-fs-source') };
  } catch (e) { if ((e as Error).name === 'AbortError') return null; throw e; }
}
