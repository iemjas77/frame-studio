/** Pure keymap logic (no DOM): chords, conflict detection, rebinding, search, import/export with validation. */
export const ACTIONS = [
  ['undo', 'Undo'], ['redo', 'Redo'], ['save', 'Save project'], ['import', 'Focus import box'], ['addEdit', 'Add edit at playhead (all unlocked tracks)'],
  ['playPause', 'Play / pause'], ['shuttleBack', 'Shuttle reverse (J)'], ['pause', 'Pause (K)'], ['shuttleFwd', 'Shuttle forward (L)'],
  ['stepBack', 'Step back 1 frame'], ['stepFwd', 'Step forward 1 frame'], ['stepBack5', 'Step back 5 frames'], ['stepFwd5', 'Step forward 5 frames'], ['toStart', 'Go to start'], ['toEnd', 'Go to end'],
  ['markIn', 'Mark in'], ['markOut', 'Mark out'], ['clearMarks', 'Clear marks'], ['marker', 'Add marker'],
  ['toolSelect', 'Selection tool'], ['toolRazor', 'Razor tool'], ['insert', 'Insert'], ['overwrite', 'Overwrite'], ['lift', 'Lift'], ['rippleDelete', 'Ripple delete'],
] as const;
export type ActionId = (typeof ACTIONS)[number][0];
export type Keymap = Record<ActionId, string[]>;
export const PRESET_VERSION = 1;

export const DEFAULT_KEYMAP: Keymap = {
  undo: ['Ctrl+Z'], redo: ['Ctrl+Shift+Z', 'Ctrl+Y'], save: ['Ctrl+S'], import: ['Ctrl+I'], addEdit: ['Ctrl+K'],
  playPause: ['Space'], shuttleBack: ['J'], pause: ['K'], shuttleFwd: ['L'], stepBack: ['ArrowLeft'], stepFwd: ['ArrowRight'], stepBack5: ['Shift+ArrowLeft'], stepFwd5: ['Shift+ArrowRight'], toStart: ['Home'], toEnd: ['End'],
  markIn: ['I'], markOut: ['O'], clearMarks: ['X'], marker: ['M'], toolSelect: ['V'], toolRazor: ['C'], insert: [','], overwrite: ['.'], lift: ['Delete', 'Backspace'], rippleDelete: ['Shift+Delete', 'Shift+Backspace'],
};

const MODS = ['Ctrl', 'Alt', 'Shift'] as const;
const NAMED = new Set(['Space', 'Delete', 'Backspace', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape', 'PageUp', 'PageDown', 'Insert']);
/** Canonical chord: modifiers in fixed order, single characters upper-case. Returns null when invalid. */
export function normalizeChord(s: string): string | null {
  const parts = s.split('+'); const key = parts.pop(); if (!key && s.endsWith('++')) parts.pop();
  let k = key === '' ? '+' : key; if (!k) return null; const mods = new Set(parts.map((p) => (p === 'Cmd' || p === 'Meta' || p === 'Control' ? 'Ctrl' : p)));
  for (const m of mods) if (!(MODS as readonly string[]).includes(m)) return null;
  if (k === ' ') k = 'Space'; if (/^F([1-9]|1[0-2])$/.test(k)) { /* function key */ } else if (k.length === 1) k = k.toUpperCase(); else if (!NAMED.has(k)) return null;
  return [...MODS.filter((m) => mods.has(m)), k].join('+');
}
export function chordFromEvent(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const mods = [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey && !(e.key.length === 1 && !/[A-Za-z]/.test(e.key)) ? 'Shift' : ''].filter(Boolean);
  return normalizeChord([...mods, e.key].join('+'));
}
export function actionFor(map: Keymap, chord: string): ActionId | null { for (const [a] of ACTIONS) if (map[a].includes(chord)) return a; return null; }
export interface Conflict { chord: string; actions: ActionId[] }
export function findConflicts(map: Keymap): Conflict[] {
  const by = new Map<string, ActionId[]>(); for (const [a] of ACTIONS) for (const c of map[a]) by.set(c, [...(by.get(c) ?? []), a]);
  return [...by].filter(([, v]) => v.length > 1).map(([chord, actions]) => ({ chord, actions }));
}
/** Add a chord to an action. Without `replace`, a clash returns the conflicting action and leaves the map unchanged. */
export function bind(map: Keymap, action: ActionId, chord: string, replace = false): { map: Keymap; conflict: ActionId | null } {
  const c = normalizeChord(chord); if (!c) throw new Error(`invalid shortcut "${chord}"`);
  const other = actionFor(map, c); if (other && other !== action && !replace) return { map, conflict: other };
  const next = Object.fromEntries(ACTIONS.map(([a]) => [a, map[a].filter((x) => x !== c || a === action)])) as Keymap;
  if (!next[action].includes(c)) next[action] = [...next[action], c]; return { map: next, conflict: null };
}
export const unbind = (map: Keymap, action: ActionId, chord: string): Keymap => ({ ...map, [action]: map[action].filter((c) => c !== chord) });
export function search(map: Keymap, q: string): ActionId[] { const n = q.trim().toLowerCase(); return ACTIONS.filter(([a, label]) => !n || label.toLowerCase().includes(n) || a.toLowerCase().includes(n) || map[a].some((c) => c.toLowerCase().includes(n))).map(([a]) => a); }
export const exportKeymap = (map: Keymap): string => JSON.stringify({ version: PRESET_VERSION, name: 'custom', bindings: map }, null, 1);
export function importKeymap(text: string): Keymap {
  if (text.length > 64_000) throw new Error('preset too large');
  const j = JSON.parse(text, (k, v) => { if (k === '__proto__' || k === 'constructor') throw new Error('forbidden key'); return v; });
  if (j?.version !== PRESET_VERSION || typeof j.bindings !== 'object' || !j.bindings) throw new Error('unsupported preset');
  const known = new Set<string>(ACTIONS.map(([a]) => a)); for (const k of Object.keys(j.bindings)) if (!known.has(k)) throw new Error(`unknown action ${k}`);
  const out = {} as Keymap; for (const [a] of ACTIONS) { const arr = j.bindings[a]; if (arr === undefined) { out[a] = [...DEFAULT_KEYMAP[a]]; continue; } if (!Array.isArray(arr)) throw new Error(`bindings.${a} must be a list`); out[a] = arr.map((c: unknown) => { const n = typeof c === 'string' ? normalizeChord(c) : null; if (!n) throw new Error(`invalid shortcut ${JSON.stringify(c)} for ${a}`); return n; }); }
  return out;
}
