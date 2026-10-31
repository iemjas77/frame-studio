import type { PathRef } from './types.ts';

/** Pure path helpers (posix and Windows styles) so resolution is testable on any OS. */
const isWin = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
const split = (p: string) => p.replace(/\\/g, '/').split('/').filter((s) => s.length > 0 && s !== '.');

export function relativeTo(baseDir: string, target: string): string | undefined {
  if (isWin(baseDir) !== isWin(target)) return undefined;
  const ci = isWin(baseDir);
  const eq = (a: string, b: string) => (ci ? a.toLowerCase() === b.toLowerCase() : a === b);
  const b = split(baseDir), t = split(target);
  if (isWin(baseDir) && b[0] && t[0] && !eq(b[0], t[0])) return undefined; // different drive
  let i = 0; while (i < b.length && i < t.length && eq(b[i]!, t[i]!)) i++;
  return [...Array(b.length - i).fill('..'), ...t.slice(i)].join('/') || '.';
}
export function resolveRelative(baseDir: string, rel: string): string {
  const win = isWin(baseDir); const parts = split(baseDir);
  for (const s of split(rel)) { if (s === '..') parts.pop(); else parts.push(s); }
  const lead = win ? (baseDir.startsWith('\\\\') ? '\\\\' : '') : '/';
  const joined = parts.join(win ? '\\' : '/');
  return lead + joined;
}
/** Candidate locations in priority order: relative-to-project first (survives moving a project folder with its media), then absolute. */
export function candidatePaths(ref: PathRef, projectDir: string): string[] {
  const out: string[] = [];
  if (ref.relative) out.push(resolveRelative(projectDir, ref.relative));
  if (!out.includes(ref.absolute)) out.push(ref.absolute);
  return out;
}
export function makePathRef(projectDir: string, absolute: string): PathRef {
  const relative = relativeTo(projectDir, absolute); return relative ? { absolute, relative } : { absolute };
}
