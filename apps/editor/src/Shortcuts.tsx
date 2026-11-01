import React, { useEffect, useState } from 'react';
import { ACTIONS, DEFAULT_KEYMAP, bind, chordFromEvent, exportKeymap, findConflicts, importKeymap, search, unbind, type ActionId, type Keymap } from './keymap.ts';

export function Shortcuts({ map, setMap, close }: { map: Keymap; setMap: (m: Keymap) => void; close: () => void }) {
  const [q, setQ] = useState(''); const [capture, setCapture] = useState<ActionId | null>(null); const [clash, setClash] = useState<{ action: ActionId; chord: string; other: ActionId } | null>(null); const [msg, setMsg] = useState(''); const [io, setIo] = useState('');
  const label = (a: ActionId) => ACTIONS.find((x) => x[0] === a)![1];
  useEffect(() => {
    if (!capture) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation(); if (e.key === 'Escape') { setCapture(null); return; }
      const c = chordFromEvent(e); if (!c) return; const r = bind(map, capture, c);
      if (r.conflict) setClash({ action: capture, chord: c, other: r.conflict }); else { setMap(r.map); setClash(null); setMsg(`Bound ${c} to ${label(capture)}`); } setCapture(null);
    };
    window.addEventListener('keydown', h, true); return () => window.removeEventListener('keydown', h, true);
  }, [capture, map]);
  const conflicts = findConflicts(map);
  return (
    <div className="modal" role="dialog" aria-label="Keyboard shortcuts" data-testid="shortcuts">
      <div className="dialog">
        <header><h2>Keyboard shortcuts</h2><span className="spacer" /><button onClick={close} data-testid="shortcuts-close">Close</button></header>
        <p className="muted">Frame Studio default preset. Shortcuts never fire while typing in a text field. This preset is not claimed to match any other editor.</p>
        <input placeholder="Search actions or keys" value={q} onChange={(e) => setQ(e.target.value)} data-testid="shortcuts-search" aria-label="Search shortcuts" />
        {conflicts.length > 0 && <div className="warn" data-testid="shortcuts-conflicts">Conflicts: {conflicts.map((c) => `${c.chord} → ${c.actions.map(label).join(' / ')}`).join('; ')}</div>}
        {clash && <div className="warn" data-testid="shortcuts-clash">{clash.chord} is already used by “{label(clash.other)}”. <button data-testid="shortcuts-replace" onClick={() => { const r = bind(map, clash.action, clash.chord, true); setMap(r.map); setMsg(`Moved ${clash.chord} to ${label(clash.action)}`); setClash(null); }}>Replace</button> <button onClick={() => setClash(null)}>Keep existing</button></div>}
        <div className="muted" data-testid="shortcuts-msg">{capture ? `Press the new shortcut for “${label(capture)}” (Esc cancels)…` : msg}</div>
        <ul className="keylist">
          {search(map, q).map((a) => (
            <li key={a} data-testid={`key-${a}`}><span>{label(a)}</span>
              <span className="chips">{map[a].map((c) => <span className="chip" key={c}>{c}<button aria-label={`Remove ${c}`} onClick={() => setMap(unbind(map, a, c))}>×</button></span>)}
                <button data-testid={`add-${a}`} onClick={() => { setCapture(a); setClash(null); }}>Add…</button></span></li>))}
        </ul>
        <div className="io"><button onClick={() => setMap({ ...DEFAULT_KEYMAP })} data-testid="shortcuts-reset">Reset to default</button><button onClick={() => setIo(exportKeymap(map))} data-testid="shortcuts-export">Export</button>
          <button data-testid="shortcuts-import" onClick={() => { try { setMap(importKeymap(io)); setMsg('Imported'); } catch (e) { setMsg(`Import failed: ${(e as Error).message}`); } }}>Import</button></div>
        <textarea rows={4} value={io} onChange={(e) => setIo(e.target.value)} placeholder="Paste a preset here to import, or press Export" data-testid="shortcuts-io" aria-label="Preset JSON" />
      </div>
    </div>
  );
}
