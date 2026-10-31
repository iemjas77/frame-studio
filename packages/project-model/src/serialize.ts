import { createHash } from 'node:crypto';
import { Envelope, FORMAT_NAME, ProjectDoc, SCHEMA_VERSION } from './types.ts';
import { Issue, hasErrors, validateProject } from './validate.ts';

/** Deterministic JSON: object keys sorted recursively, 1-space indent (diff-friendly, stable checksum). */
export function canonicalJson(v: unknown, indent?: number): string {
  const sort = (x: unknown): unknown => Array.isArray(x) ? x.map(sort)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])])) : x;
  return JSON.stringify(sort(v), null, indent);
}
export const checksumOf = (p: ProjectDoc): string => createHash('sha256').update(canonicalJson(p)).digest('hex');

export function serializeProject(p: ProjectDoc, appVersion: string, now = new Date()): string {
  const issues = validateProject(p);
  if (hasErrors(issues)) throw new ProjectFormatError('invalid', 'refusing to save an invalid project', issues);
  const env: Envelope = { format: FORMAT_NAME, schemaVersion: SCHEMA_VERSION, appVersion, savedAt: now.toISOString(), checksum: { algo: 'sha256', value: checksumOf(p) }, project: p };
  return canonicalJson(env, 1) + '\n';
}

export type FormatErrorCode = 'syntax' | 'not-project' | 'newer-schema' | 'checksum' | 'invalid' | 'migration';
export class ProjectFormatError extends Error {
  constructor(readonly code: FormatErrorCode, message: string, readonly issues: Issue[] = []) { super(message); this.name = 'ProjectFormatError'; }
}

/** Migration policy: each step upgrades exactly one version, is pure, and must preserve unknown fields. Newer files are refused, never downgraded or rewritten. */
export type Migration = (envelopeProject: Record<string, unknown>) => Record<string, unknown>;
export const MIGRATIONS: Record<number, Migration> = {}; // key N: upgrades N -> N+1. None yet (v1 is the first schema).

export interface ParseResult { project: ProjectDoc; migratedFrom: number | null; warnings: Issue[]; appVersion: string }
export function parseProject(text: string, opts: { migrations?: Record<number, Migration>; currentVersion?: number; verifyChecksum?: boolean } = {}): ParseResult {
  const current = opts.currentVersion ?? SCHEMA_VERSION; const migrations = opts.migrations ?? MIGRATIONS;
  let env: any;
  try { env = JSON.parse(text); } catch (e) { throw new ProjectFormatError('syntax', `not valid JSON (file truncated or corrupt?): ${(e as Error).message}`); }
  if (!env || env.format !== FORMAT_NAME || typeof env.schemaVersion !== 'number' || typeof env.project !== 'object') throw new ProjectFormatError('not-project', 'not a Frame Studio project file');
  if (env.schemaVersion > current) throw new ProjectFormatError('newer-schema', `project schema ${env.schemaVersion} is newer than supported ${current}; update Frame Studio. File left untouched.`);
  let proj = env.project as Record<string, unknown>; const from = env.schemaVersion as number;
  if (from === current && opts.verifyChecksum !== false) {
    const want = env.checksum?.value; const got = checksumOf(proj as ProjectDoc);
    if (want !== got) throw new ProjectFormatError('checksum', 'checksum mismatch: file was modified or damaged after save');
  }
  for (let v = from; v < current; v++) {
    const step = migrations[v]; if (!step) throw new ProjectFormatError('migration', `no migration from schema ${v} to ${v + 1}`);
    try { proj = step(proj); } catch (e) { throw new ProjectFormatError('migration', `migration ${v}->${v + 1} failed: ${(e as Error).message}`); }
  }
  const issues = validateProject(proj as ProjectDoc);
  if (hasErrors(issues)) throw new ProjectFormatError('invalid', `project failed validation (${issues.filter((i) => i.severity === 'error').length} errors)`, issues);
  return { project: proj as ProjectDoc, migratedFrom: from < current ? from : null, warnings: issues.filter((i) => i.severity === 'warning'), appVersion: String(env.appVersion ?? '') };
}
