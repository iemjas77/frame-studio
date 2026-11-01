import { describe, it, expect } from 'vitest';
import { ACTIONS, DEFAULT_KEYMAP, actionFor, bind, chordFromEvent, exportKeymap, findConflicts, importKeymap, normalizeChord, search, unbind } from '../../apps/editor/src/keymap.ts';

describe('keymap', () => {
  it('default preset has no conflicts and covers every action', () => { expect(findConflicts(DEFAULT_KEYMAP)).toEqual([]); for (const [a] of ACTIONS) expect(DEFAULT_KEYMAP[a].length).toBeGreaterThan(0); });
  it('normalises chords and events', () => {
    expect(normalizeChord('shift+ctrl+z')).toBeNull(); expect(normalizeChord('Shift+Ctrl+z')).toBe('Ctrl+Shift+Z'); expect(normalizeChord('Cmd+S')).toBe('Ctrl+S'); expect(normalizeChord('Ctrl++')).toBe('Ctrl++'); expect(normalizeChord('Hyper+X')).toBeNull(); expect(normalizeChord('F5')).toBe('F5');
    expect(chordFromEvent({ key: ' ', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe('Space'); expect(chordFromEvent({ key: 'z', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe('Ctrl+Shift+Z'); expect(chordFromEvent({ key: 'Shift', ctrlKey: false, metaKey: false, altKey: false, shiftKey: true })).toBeNull();
    expect(chordFromEvent({ key: ',', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe(',');
  });
  it('detects conflicts and only rebinds with explicit replace', () => {
    const r = bind(DEFAULT_KEYMAP, 'marker', 'C'); expect(r.conflict).toBe('toolRazor'); expect(r.map).toBe(DEFAULT_KEYMAP);
    const r2 = bind(DEFAULT_KEYMAP, 'marker', 'C', true); expect(r2.conflict).toBeNull(); expect(actionFor(r2.map, 'C')).toBe('marker'); expect(r2.map.toolRazor).toEqual([]); expect(findConflicts(r2.map)).toEqual([]);
    expect(bind(DEFAULT_KEYMAP, 'marker', 'Ctrl+Alt+M').map.marker).toEqual(['M', 'Ctrl+Alt+M']); expect(() => bind(DEFAULT_KEYMAP, 'marker', 'nonsense+')).toThrow(); expect(unbind(DEFAULT_KEYMAP, 'redo', 'Ctrl+Y').redo).toEqual(['Ctrl+Shift+Z']);
  });
  it('searches labels, ids and chords', () => { expect(search(DEFAULT_KEYMAP, 'razor')).toEqual(['toolRazor']); expect(search(DEFAULT_KEYMAP, 'ctrl+s')).toContain('save'); expect(search(DEFAULT_KEYMAP, '')).toHaveLength(ACTIONS.length); });
  it('export/import round-trips and rejects malicious or malformed presets', () => {
    expect(importKeymap(exportKeymap(DEFAULT_KEYMAP))).toEqual(DEFAULT_KEYMAP);
    expect(() => importKeymap('{"version":1,"bindings":{"rm":["X"]}}')).toThrow(/unknown action/); expect(() => importKeymap('{"version":2,"bindings":{}}')).toThrow(/unsupported/); expect(() => importKeymap('{"version":1,"bindings":{"undo":["Zzz+"]}}')).toThrow(/invalid shortcut/);
    expect(() => importKeymap('{"version":1,"bindings":{"__proto__":{}}}')).toThrow(); expect(() => importKeymap('x'.repeat(70000))).toThrow(/too large/);
    expect(importKeymap('{"version":1,"bindings":{"undo":["Ctrl+Q"]}}').redo).toEqual(DEFAULT_KEYMAP.redo);
  });
});
