/**
 * Macros: versioned, allowlisted, data-only. A macro is a list of semantic commands with `${param}` placeholders.
 * Nothing in a macro is ever evaluated as code, and only the allowlisted command types can appear.
 */
import type { Command, CommandEngine } from '@fs/command-engine';

export const MACRO_VERSION = 1;
export const ALLOWED_STEPS = ['edit.insert', 'edit.overwrite', 'edit.append', 'edit.split', 'edit.lift', 'edit.rippleDelete', 'edit.removeGap', 'edit.move', 'edit.trim', 'edit.slip', 'edit.link', 'edit.unlink',
  'marker.add', 'marker.remove', 'marker.move', 'track.set', 'sequence.setRange'] as const;
export interface ParamDef { type: 'number' | 'string'; default?: number | string }
export interface Macro { version: 1; name: string; params: Record<string, ParamDef>; steps: Record<string, unknown>[] }
export interface MacroIssue { path: string; message: string }
const MAX_BYTES = 256 * 1024, MAX_STEPS = 500, NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const bannedKey = (k: string) => k === '__proto__' || k === 'constructor' || k === 'prototype';

export function parseMacro(text: string): Macro {
  if (text.length > MAX_BYTES) throw new Error('macro file too large');
  const m = JSON.parse(text, (k, v) => { if (bannedKey(k)) throw new Error(`forbidden key ${k}`); return v; }) as Macro;
  const issues = validateMacro(m); if (issues.length) throw new Error(`invalid macro: ${issues.slice(0, 5).map((i) => `${i.path}: ${i.message}`).join('; ')}`); return m;
}
export function validateMacro(m: Macro): MacroIssue[] {
  const out: MacroIssue[] = []; const bad = (path: string, message: string) => out.push({ path, message });
  if (!m || typeof m !== 'object') return [{ path: '', message: 'not an object' }];
  for (const k of Object.keys(m)) if (!['version', 'name', 'params', 'steps'].includes(k)) bad(k, 'unknown field');
  if (m.version !== MACRO_VERSION) bad('version', `unsupported version (supported: ${MACRO_VERSION})`);
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 80) bad('name', 'name required (≤ 80 chars)');
  if (!m.params || typeof m.params !== 'object') bad('params', 'params must be an object'); else for (const [k, p] of Object.entries(m.params)) { if (!NAME_RE.test(k)) bad(`params.${k}`, 'bad parameter name'); if (p?.type !== 'number' && p?.type !== 'string') bad(`params.${k}.type`, 'must be number or string'); }
  if (!Array.isArray(m.steps) || m.steps.length === 0 || m.steps.length > MAX_STEPS) { bad('steps', `1..${MAX_STEPS} steps required`); return out; }
  m.steps.forEach((s, i) => {
    if (!s || typeof s !== 'object' || typeof s.type !== 'string') return bad(`steps[${i}]`, 'step needs a type');
    if (!(ALLOWED_STEPS as readonly string[]).includes(s.type)) bad(`steps[${i}].type`, `"${s.type}" is not an allowed macro step`);
    const walk = (v: unknown, p: string) => { if (typeof v === 'string') for (const mm of v.matchAll(/\$\{([^}]*)\}/g)) if (!m.params || !(mm[1]! in m.params)) bad(p, `unknown parameter ${mm[1]}`); else if (v.length > 400) bad(p, 'string too long'); if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (bannedKey(k)) bad(p, `forbidden key ${k}`); walk(x, `${p}.${k}`); } };
    walk(s, `steps[${i}]`);
  });
  return out;
}
/** Parameter substitution: a string that is exactly "${p}" takes the parameter's typed value; embedded placeholders only accept string/number text. */
export function expandMacro(m: Macro, args: Record<string, number | string> = {}): Command[] {
  const issues = validateMacro(m); if (issues.length) throw new Error(`invalid macro: ${issues[0]!.path}: ${issues[0]!.message}`);
  const val: Record<string, number | string> = {};
  for (const [k, d] of Object.entries(m.params)) { const v = args[k] ?? d.default; if (v === undefined) throw new Error(`missing parameter ${k}`); if (typeof v !== d.type) throw new Error(`parameter ${k} must be a ${d.type}`); if (d.type === 'number' && !Number.isFinite(v as number)) throw new Error(`parameter ${k} must be finite`); val[k] = v; }
  for (const k of Object.keys(args)) if (!(k in m.params)) throw new Error(`unknown parameter ${k}`);
  const sub = (v: unknown): unknown => typeof v === 'string' ? (/^\$\{([^}]+)\}$/.exec(v) ? val[/^\$\{([^}]+)\}$/.exec(v)![1]!] : v.replace(/\$\{([^}]+)\}/g, (_, k) => String(val[k]))) : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v;
  return m.steps.map((s) => sub(s) as unknown as Command);
}
/** Runs the macro as ONE undoable, atomic transaction. */
export function runMacro(engine: CommandEngine, m: Macro, args: Record<string, number | string> = {}) { return engine.execute({ type: 'batch', commands: expandMacro(m, args) }, `Macro: ${m.name}`); }
/** Record committed commands as a (parameterless) macro; steps outside the allowlist are reported, not recorded. */
export function recordMacro(name: string, committed: Command[]): { macro: Macro; skipped: string[] } {
  const skipped: string[] = []; const steps = committed.filter((c) => { const ok = (ALLOWED_STEPS as readonly string[]).includes(c.type); if (!ok) skipped.push(c.type); return ok; }) as unknown as Record<string, unknown>[];
  return { macro: { version: 1, name, params: {}, steps: JSON.parse(JSON.stringify(steps)) }, skipped };
}
