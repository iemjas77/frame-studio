import React, { useMemo, useState } from 'react';
import { framesToTimecode, seconds } from '@fs/timeline-model';
import type { MediaRef } from '@fs/project-model';
import { api, ApiError, type Snapshot } from './api.ts';

export interface MediaPanelProps { snap: Snapshot; selectedId: string | null; onSelect: (id: string) => void; run: (fn: () => Promise<Snapshot>) => Promise<void>; setSnap: (s: Snapshot) => void; setHint: (h: string | null) => void }

interface Bridge { pickMedia: () => Promise<string[]>; pathForFile: (f: File) => string }
const bridge: Bridge | undefined = (window as unknown as { frameStudio?: Bridge }).frameStudio;

export function MediaPanel({ snap, selectedId, onSelect, run, setSnap, setHint }: MediaPanelProps) {
  const [paths, setPaths] = useState(''); const [q, setQ] = useState(''); const [sort, setSort] = useState<'name' | 'duration' | 'rate'>('name'); const [relinkFor, setRelinkFor] = useState<string | null>(null); const [relinkPath, setRelinkPath] = useState(''); const [relinkMsg, setRelinkMsg] = useState('');
  const doc = snap.project;
  const list = useMemo(() => {
    const all = doc.mediaOrder.map((id) => doc.mediaPool[id]!).filter((m) => m.name.toLowerCase().includes(q.toLowerCase()));
    const dur = (m: MediaRef) => (m.video ? seconds(m.video.duration).toNumber() : m.audio ? seconds(m.audio.duration).toNumber() : 0);
    return all.sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'duration' ? dur(b) - dur(a) : (b.video?.rate.num ?? 0) / (b.video?.rate.den ?? 1) - (a.video?.rate.num ?? 0) / (a.video?.rate.den ?? 1)));
  }, [doc, q, sort]);
  const binPath = (id: string | null): string => { const out: string[] = []; let cur = id; while (cur) { const b = doc.bins[cur]; if (!b) break; out.unshift(b.name); cur = b.parentId; } return out.join(' / '); };
  const doImport = async () => {
    const list = paths.split('\n').map((s) => s.trim()).filter(Boolean); if (!list.length) return;
    try { const r = await api.import(list); setSnap(r.state); const bad = r.results.filter((x) => !x.ok); setHint(bad.length ? `Import: ${bad.map((b) => `${b.path.split(/[\\/]/).pop()}: ${b.error}`).join(' | ')}` : null); if (!bad.length) setPaths(''); } catch (e) { setHint(String((e as Error).message)); }
  };
  const doRelink = async (confirm = false) => {
    if (!relinkFor) return; try {
      const r = await api.relink(relinkFor, relinkPath.trim(), confirm); setSnap(r.state);
      if (r.ok) { setRelinkFor(null); setRelinkPath(''); setRelinkMsg(''); setHint(null); } else if (r.needsConfirmation) setRelinkMsg(`Likely the same footage, but bytes differ: ${r.verdict.reasons.join('; ')}. Press "Relink anyway" to accept.`); else setRelinkMsg(`Refused: ${r.verdict.reasons.join('; ')}`);
    } catch (e) { setRelinkMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e)); }
  };
  return (
    <section className="panel media" data-testid="media-panel"
      onDragOver={(e) => { if (bridge) e.preventDefault(); }}
      onDrop={(e) => { if (!bridge) return; e.preventDefault(); const dropped = [...e.dataTransfer.files].map((f) => bridge.pathForFile(f)).filter(Boolean); if (dropped.length) { setPaths(dropped.join('\n')); void api.import(dropped).then((r) => { setSnap(r.state); const bad = r.results.filter((x) => !x.ok); setHint(bad.length ? `Import: ${bad.map((b) => `${b.path.split(/[\\/]/).pop()}: ${b.error}`).join(' | ')}` : null); if (!bad.length) setPaths(''); }); } }}>
      <header><h2>Project · {doc.name}</h2></header>
      <div className="importbox">
        <textarea rows={2} placeholder="Absolute path(s) to files or folders, one per line" value={paths} onChange={(e) => setPaths(e.target.value)} data-testid="import-paths" aria-label="Import paths" />
        <div className="importbtns"><button onClick={doImport} data-testid="btn-import" title="Import (Ctrl+I focuses the path box)">Import</button>
          {bridge && <button onClick={async () => { const picked = await bridge.pickMedia(); if (picked.length) setPaths(picked.join('\n')); }} data-testid="btn-browse" title="Choose files or a folder">Browse…</button>}</div>
      </div>
      <div className="filters"><input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} data-testid="media-search" aria-label="Search media" />
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort media" data-testid="media-sort"><option value="name">name</option><option value="duration">duration</option><option value="rate">frame rate</option></select></div>
      <ul className="medialist">
        {list.map((m) => {
          const st = snap.mediaStatus[m.id]; const dur = m.video ? framesToTimecode(m.video.duration.ticks, { rate: m.video.rate, dropFrame: false }) : m.audio ? (m.audio.duration.ticks / m.audio.sampleRate).toFixed(2) + ' s' : '';
          return (
            <li key={m.id} className={`${selectedId === m.id ? 'sel' : ''} ${st !== 'ok' ? 'bad' : ''}`} data-testid={`media-${m.name}`} onClick={() => onSelect(m.id)} onDoubleClick={() => onSelect(m.id)}>
              {m.video && st === 'ok' ? <img src={api.thumbUrl(m.id)} alt="" width={64} height={36} /> : <div className="nothumb">{m.audio && !m.video ? '♪' : '?'}</div>}
              <div className="meta"><b>{m.name}</b><span className="muted">{binPath(m.binId)}</span>
                <span className="muted">{m.video ? `${m.video.width}×${m.video.height} · ${(m.video.rate.num / m.video.rate.den).toFixed(3)} fps${m.video.rotation ? ` · rot ${m.video.rotation}°` : ''}` : ''}{m.audio ? ` · ${m.audio.sampleRate / 1000} kHz ${m.audio.channels}ch` : ''} · {dur}</span>
                {st !== 'ok' && <span className="badge" data-testid={`status-${m.name}`}>{st === 'missing' ? 'MEDIA OFFLINE' : 'FILE CHANGED'} <button onClick={(e) => { e.stopPropagation(); setRelinkFor(m.id); setRelinkMsg(''); }} data-testid={`relink-${m.name}`}>Relink…</button></span>}
              </div>
            </li>);
        })}
        {list.length === 0 && <li className="muted empty">No media yet. Paste absolute file or folder paths above and press Import.</li>}
      </ul>
      {relinkFor && (
        <div className="relink" data-testid="relink-box"><div>Relink <b>{doc.mediaPool[relinkFor]?.name}</b>. Candidates are checked by content, not by name.</div>
          <input placeholder="Absolute path of the replacement file" value={relinkPath} onChange={(e) => setRelinkPath(e.target.value)} data-testid="relink-path" aria-label="Relink path" />
          <div><button onClick={() => doRelink(false)} data-testid="relink-go">Relink</button><button onClick={() => doRelink(true)} data-testid="relink-confirm">Relink anyway</button><button onClick={() => setRelinkFor(null)}>Cancel</button></div>
          {relinkMsg && <div className="warn" data-testid="relink-msg">{relinkMsg}</div>}</div>)}
    </section>
  );
}

export function ExportPanel({ snap, seqId, setSnap }: { snap: Snapshot; seqId: string; setSnap: (s: Snapshot) => void }) {
  const [dest, setDest] = useState(''); const [overwrite, setOverwrite] = useState(false); const [msg, setMsg] = useState('');
  const start = async () => { try { await api.exportSeq(seqId, dest.trim(), overwrite); setMsg(''); setSnap(await api.state()); } catch (e) { setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e)); } };
  return (
    <section className="panel export" data-testid="export-panel">
      <header><h2>Export</h2></header>
      <div className="exportform">
        <input placeholder="Destination, e.g. /home/me/out.mp4" value={dest} onChange={(e) => setDest(e.target.value)} data-testid="export-dest" aria-label="Export destination" />
        <label><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} data-testid="export-overwrite" /> allow overwrite</label>
        <button onClick={start} data-testid="btn-export">Export H.264 / AAC MP4</button>
        <div className="muted">Sequence in/out range if set. Output is verified by decoding it back; colour is untagged/unmanaged.</div>
        {msg && <div className="warn" data-testid="export-msg">{msg}</div>}
      </div>
      <ul className="jobs" data-testid="jobs">
        {snap.jobs.slice().reverse().map((j) => (
          <li key={j.id} data-testid={`job-${j.id}`}><div><b>{j.label}</b> <span className="muted" data-testid="job-phase">{j.progress.phase}</span></div>
            {!j.report && <><progress max={1} value={j.progress.fraction} /><button onClick={() => api.cancelJob(j.id)} data-testid="job-cancel">Cancel</button></>}
            {j.report && <div className={j.report.ok ? 'ok' : 'warn'} data-testid="job-result">{j.report.ok ? `Done → ${j.report.output}` : 'Failed / cancelled'}
              <ul className="checks">{j.report.checks.map((c, i) => <li key={i} className={c.ok ? 'ok' : 'warn'}>{c.ok ? '✓' : '✗'} {c.name}: <span className="muted">{c.detail}</span></li>)}</ul>
              {j.report.warnings.map((w, i) => <div key={i} className="muted">⚠ {w}</div>)}</div>}
          </li>))}
      </ul>
    </section>
  );
}
