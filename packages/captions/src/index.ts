/** SRT / WebVTT parsing, writing, validation and basic cue editing. Times are integer milliseconds in files; frame conversion is explicit. */
import { Frac, Rate, rateFrac } from '@fs/timeline-model';

export interface Cue { id: string; startMs: number; endMs: number; text: string; settings?: string }
export interface CaptionIssue { severity: 'error' | 'warning'; cue: string; code: string; message: string }

const ts = (ms: number, sep: ',' | '.') => { const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, x = ms % 1000; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(x).padStart(3, '0')}`; };
const T = String.raw`(?:(\d{1,3}):)?(\d{2}):(\d{2})[,.](\d{3})`;
const TIMING = new RegExp(`^${T}\\s*-->\\s*${T}(?:\\s+(.*))?$`);
const toMs = (h: string | undefined, m: string, s: string, x: string) => (+(h ?? 0) * 3600 + +m * 60 + +s) * 1000 + +x;
const norm = (t: string) => t.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

export function parseSrt(text: string): { cues: Cue[]; warnings: string[] } {
  const warnings: string[] = []; const cues: Cue[] = [];
  for (const block of norm(text).split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)) {
    const lines = block.split('\n'); let i = 0; let id = String(cues.length + 1);
    if (!TIMING.test(lines[0]!) && lines[1] && TIMING.test(lines[1])) { id = lines[0]!.trim(); i = 1; }
    const m = TIMING.exec(lines[i] ?? ''); if (!m) { warnings.push(`skipped block without a valid timing line: "${block.slice(0, 40)}"`); continue; }
    cues.push({ id, startMs: toMs(m[1], m[2]!, m[3]!, m[4]!), endMs: toMs(m[5], m[6]!, m[7]!, m[8]!), text: lines.slice(i + 1).join('\n') });
  }
  return { cues, warnings };
}
export function parseVtt(text: string): { cues: Cue[]; warnings: string[] } {
  const t = norm(text); const warnings: string[] = [];
  if (!/^WEBVTT(?:[ \t\n]|$)/.test(t)) throw new SyntaxError('not a WebVTT file (missing WEBVTT header)');
  const cues: Cue[] = [];
  for (const block of t.split(/\n{2,}/).slice(1).map((b) => b.trim()).filter(Boolean)) {
    if (/^(NOTE|STYLE|REGION)\b/.test(block)) { if (!block.startsWith('NOTE')) warnings.push(`${block.split(/\s/)[0]} block ignored (not supported)`); continue; }
    const lines = block.split('\n'); let i = 0; let id = String(cues.length + 1);
    if (!TIMING.test(lines[0]!) && lines[1] && TIMING.test(lines[1])) { id = lines[0]!; i = 1; }
    const m = TIMING.exec(lines[i] ?? ''); if (!m) { warnings.push(`skipped block without timing: "${block.slice(0, 40)}"`); continue; }
    cues.push({ id, startMs: toMs(m[1], m[2]!, m[3]!, m[4]!), endMs: toMs(m[5], m[6]!, m[7]!, m[8]!), text: lines.slice(i + 1).join('\n'), ...(m[9] ? { settings: m[9] } : {}) });
  }
  return { cues, warnings };
}
export const serializeSrt = (cues: Cue[]): string => cues.map((c, i) => `${i + 1}\n${ts(c.startMs, ',')} --> ${ts(c.endMs, ',')}\n${c.text}\n`).join('\n');
export const serializeVtt = (cues: Cue[]): string => `WEBVTT\n\n${cues.map((c) => `${ts(c.startMs, '.')} --> ${ts(c.endMs, '.')}${c.settings ? ' ' + c.settings : ''}\n${c.text.replace(/\n\n+/g, '\n')}\n`).join('\n')}`;

export function validateCues(cues: Cue[], o: { minMs?: number; maxCps?: number; maxLineChars?: number; maxLines?: number } = {}): CaptionIssue[] {
  const min = o.minMs ?? 500, cps = o.maxCps ?? 20, lc = o.maxLineChars ?? 42, ml = o.maxLines ?? 2; const out: CaptionIssue[] = [];
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs);
  sorted.forEach((c, i) => {
    const add = (severity: CaptionIssue['severity'], code: string, message: string) => out.push({ severity, cue: c.id, code, message });
    if (c.endMs <= c.startMs) add('error', 'duration', 'end must be after start');
    else if (c.endMs - c.startMs < min) add('warning', 'short', `shorter than ${min} ms`);
    if (!c.text.trim()) add('error', 'empty', 'empty text');
    const lines = c.text.split('\n'); if (lines.length > ml) add('warning', 'lines', `${lines.length} lines (max ${ml})`);
    if (lines.some((l) => [...l].length > lc)) add('warning', 'width', `line longer than ${lc} characters`);
    const chars = [...c.text.replace(/\n/g, '')].length; if (c.endMs > c.startMs && chars / ((c.endMs - c.startMs) / 1000) > cps) add('warning', 'speed', `reading speed above ${cps} characters/second`);
    const prev = sorted[i - 1]; if (prev && c.startMs < prev.endMs) add('error', 'overlap', `overlaps cue ${prev.id}`);
  });
  return out;
}

/** Conversion to the sequence frame grid with explicit rounding (nearest). Cues shorter than one frame become one frame. */
export const msToFrames = (ms: number, rate: Rate): number => Number(Frac.of(ms, 1000).mul(rateFrac(rate)).round('nearest'));
export const framesToMs = (f: number, rate: Rate): number => Number(Frac.of(f).div(rateFrac(rate)).mul(Frac.of(1000)).round('nearest'));
export function cuesToFrames(cues: Cue[], rate: Rate) { return cues.map((c) => { const s = msToFrames(c.startMs, rate); return { id: c.id, start: s, end: Math.max(s + 1, msToFrames(c.endMs, rate)), text: c.text }; }); }

export function splitCue(c: Cue, atMs: number, charIndex: number, newId: string): [Cue, Cue] {
  if (!(atMs > c.startMs && atMs < c.endMs)) throw new RangeError('split time must be inside the cue');
  const chars = [...c.text]; if (charIndex <= 0 || charIndex >= chars.length) throw new RangeError('split index must be inside the text');
  return [{ ...c, endMs: atMs, text: chars.slice(0, charIndex).join('').trimEnd() }, { ...c, id: newId, startMs: atMs, text: chars.slice(charIndex).join('').trimStart() }];
}
export function mergeCues(a: Cue, b: Cue): Cue { if (b.startMs < a.startMs) [a, b] = [b, a]; return { ...a, endMs: Math.max(a.endMs, b.endMs), text: `${a.text}\n${b.text}` }; }
export function trimCue(c: Cue, startMs: number, endMs: number): Cue { if (endMs <= startMs) throw new RangeError('end must be after start'); return { ...c, startMs, endMs }; }
