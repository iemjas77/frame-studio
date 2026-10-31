/** Node-only persistence: atomic saves, rotating autosaves, recovery journal, last-valid-file recovery. */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ParseResult, ProjectFormatError, parseProject, serializeProject } from './serialize.ts';
import type { ProjectDoc } from './types.ts';

export interface FsHooks { /** test seam: called between phases of a save */ beforeRename?: () => void }

/**
 * Atomic save: write temp file in the SAME directory, fsync, keep the previous version as `.bak`,
 * then rename over the target. A crash leaves either the old or the new complete file, plus possibly a stray `.tmp-*`.
 * (Windows: fs.rename replaces an existing file via MoveFileEx; verified only on Linux in this session.)
 */
export function saveProjectAtomic(file: string, doc: ProjectDoc, appVersion: string, hooks: FsHooks = {}): void {
  const text = serializeProject(doc, appVersion);
  const dir = path.dirname(file); fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    hooks.beforeRename?.();
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } throw e; }
  try { const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* directory fsync unsupported (e.g. Windows) */ }
}

export const autosaveDir = (file: string): string => `${file}.autosave`;

/** Rotating autosaves: autosave-<seq>.fstudio, newest has highest seq; keeps `keep` files. Never touches the main file. */
export function writeAutosave(file: string, doc: ProjectDoc, appVersion: string, keep = 5): string {
  const dir = autosaveDir(file); fs.mkdirSync(dir, { recursive: true });
  const seqs = listAutosaves(file).map((a) => a.seq); const seq = (seqs.length ? Math.max(...seqs) : 0) + 1;
  const target = path.join(dir, `autosave-${String(seq).padStart(6, '0')}.fstudio`);
  saveProjectAtomic(target, doc, appVersion);
  fs.rmSync(`${target}.bak`, { force: true });
  const all = listAutosaves(file); for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(old.file, { force: true });
  return target;
}
export function listAutosaves(file: string): { seq: number; file: string }[] {
  const dir = autosaveDir(file); if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((n) => /^autosave-(\d+)\.fstudio$/.exec(n)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ seq: Number(m[1]), file: path.join(dir, m[0]) })).sort((a, b) => a.seq - b.seq);
}

export interface LoadAttempt { source: 'main' | 'backup' | 'autosave'; file: string; ok: boolean; error?: string }
export interface Recovered extends ParseResult { source: LoadAttempt['source']; file: string; attempts: LoadAttempt[] }

/** Open a project; if the main file is unreadable fall back to .bak, then newest valid autosave. Reports every attempt. */
export function openProjectWithRecovery(file: string): Recovered {
  const attempts: LoadAttempt[] = [];
  const candidates: { source: LoadAttempt['source']; file: string }[] = [
    { source: 'main', file }, { source: 'backup', file: `${file}.bak` },
    ...listAutosaves(file).reverse().map((a) => ({ source: 'autosave' as const, file: a.file })),
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c.file)) continue;
    try {
      const r = parseProject(fs.readFileSync(c.file, 'utf8')); attempts.push({ ...c, ok: true });
      return { ...r, source: c.source, file: c.file, attempts };
    } catch (e) {
      attempts.push({ ...c, ok: false, error: (e as Error).message });
      if (e instanceof ProjectFormatError && e.code === 'newer-schema') throw e; // never fall back past a newer-schema refusal
    }
  }
  throw new ProjectFormatError('invalid', `no readable project found. Attempts: ${attempts.map((a) => `${a.source}: ${a.error}`).join('; ') || 'file not found'}`);
}

/* ---- recovery journal: JSON lines, each with its own checksum so a torn final line is detected and dropped ---- */
export interface JournalHeader { kind: 'header'; projectId: string; /** checksum of the saved project this journal applies on top of */ baseChecksum: string }
export interface JournalEntry { kind: 'tx'; revision: number; txId: string; command: unknown }
const lineSum = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
export const journalPath = (file: string): string => `${file}.journal`;

export function journalStart(file: string, header: JournalHeader): void {
  const body = JSON.stringify(header); fs.writeFileSync(journalPath(file), `${lineSum(body)} ${body}\n`);
}
export function journalAppend(file: string, entry: JournalEntry): void {
  const body = JSON.stringify(entry); const fd = fs.openSync(journalPath(file), 'a');
  try { fs.writeSync(fd, `${lineSum(body)} ${body}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function journalRead(file: string): { header: JournalHeader; entries: JournalEntry[]; droppedTail: boolean } | null {
  const p = journalPath(file); if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.length);
  let header: JournalHeader | null = null; const entries: JournalEntry[] = []; let dropped = false;
  for (const l of lines) {
    const sp = l.indexOf(' '); const sum = l.slice(0, sp), body = l.slice(sp + 1);
    if (sp < 0 || lineSum(body) !== sum) { dropped = true; break; } // torn/corrupt: stop at first bad line
    const o = JSON.parse(body); if (o.kind === 'header') header = o; else if (header) entries.push(o);
  }
  return header ? { header, entries, droppedTail: dropped } : null;
}
export function journalClear(file: string): void { fs.rmSync(journalPath(file), { force: true }); }
