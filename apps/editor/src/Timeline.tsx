import React, { useEffect, useMemo, useRef, useState } from 'react';
import { framesToTimecode, seconds, supportsDropFrame } from '@fs/timeline-model';
import type { Clip, ProjectDoc, Sequence, Track } from '@fs/project-model';
import type { Command } from '@fs/command-engine';
import { sequenceEnd, type Transport } from '@fs/playback';
import { api, ApiError, type Snapshot } from './api.ts';

export type Tool = 'select' | 'razor';
export interface TimelineProps {
  snap: Snapshot; seq: Sequence; transport: Transport; selection: Set<string>; setSelection: (s: Set<string>) => void; tool: Tool; snapping: boolean; ripple: boolean;
  run: (fn: () => Promise<Snapshot>) => Promise<void>; setHint: (h: string | null) => void; setSnap: (s: Snapshot) => void; playhead: number;
}
const HEADER_W = 168;
const peaksCache = new Map<string, Promise<number[] | null>>();
const getPeaks = (id: string) => { let p = peaksCache.get(id); if (!p) { p = api.waveform(id).then((w) => w.peaks).catch(() => null); peaksCache.set(id, p); } return p; };

function Wave({ doc, clip, seq, ppf }: { doc: ProjectDoc; clip: Clip; seq: Sequence; ppf: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true; const m = doc.mediaPool[clip.mediaId]; if (!m?.audio) return;
    getPeaks(clip.mediaId).then((peaks) => {
      const c = ref.current; if (!live || !c || !peaks) return; const w = Math.max(1, Math.min(4000, Math.floor(clip.duration * ppf))); c.width = w; c.height = 28;
      const total = seconds(m.audio!.duration).toNumber() || 1; const s0 = seconds(clip.sourceIn).toNumber(); const spanSec = clip.duration * seq.rate.den / seq.rate.num;
      const g = c.getContext('2d')!; g.clearRect(0, 0, w, 28); g.fillStyle = 'rgba(255,255,255,.55)';
      for (let x = 0; x < w; x++) { const i = Math.min(peaks.length - 1, Math.floor(((s0 + (x / w) * spanSec) / total) * peaks.length)); const h = Math.max(1, (peaks[i] ?? 0) * 26); g.fillRect(x, 14 - h / 2, 1, h); }
    });
    return () => { live = false; };
  }, [clip.mediaId, clip.sourceIn.ticks, clip.duration, ppf]);
  return <canvas ref={ref} className="wave" />;
}

export function Timeline(p: TimelineProps) {
  const { seq, snap, transport } = p; const doc = snap.project;
  const [ppf, setPpf] = useState(4); const lanes = useRef<HTMLDivElement>(null); const end = sequenceEnd(seq);
  const width = Math.max(end + 250, 600) * ppf;
  const rows = useMemo(() => [...[...seq.videoTracks].reverse(), ...seq.audioTracks], [seq]);
  const drag = useRef<null | { clipId: string; mode: 'move' | 'start' | 'end'; x0: number; y0: number; start: number; end: number; active: boolean; kind: 'video' | 'audio'; pending: Command | null; busy: boolean; ok: boolean }>(null);
  const [play, setPlay] = useState(0); useEffect(() => { let r = 0; const f = () => { setPlay(transport.position()); r = requestAnimationFrame(f); }; r = requestAnimationFrame(f); return () => cancelAnimationFrame(r); }, [transport]);
  const df = seq.dropFrame && supportsDropFrame(seq.rate);
  const frameAt = (clientX: number) => Math.max(0, Math.round((clientX - lanes.current!.getBoundingClientRect().left) / ppf));
  const snapPoints = (exclude: Set<string>) => { const pts = new Set<number>([0, transport.position()]); for (const t of [...seq.videoTracks, ...seq.audioTracks]) for (const c of t.clips) if (!exclude.has(c.id)) { pts.add(c.start); pts.add(c.start + c.duration); } return [...pts]; };
  const group = (c: Clip) => (c.linkGroupId ? new Set(rows.flatMap((t) => t.clips).filter((x) => x.linkGroupId === c.linkGroupId).map((x) => x.id)) : new Set([c.id]));

  const pump = async () => {
    const d = drag.current; if (!d || d.busy) return; d.busy = true;
    try { while (d.pending) { const c = d.pending; d.pending = null; try { const s = await api.gesture('update', { command: c }); p.setSnap(s); d.ok = true; p.setHint(null); } catch (e) { d.ok = false; p.setHint(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e)); } } } finally { d.busy = false; }
  };
  const onClipDown = (e: React.PointerEvent, clip: Clip, track: Track) => {
    if (e.button !== 0) return; e.stopPropagation();
    if (p.tool === 'razor') { const t = frameAt(e.clientX); void p.run(() => api.command({ type: 'edit.split', sequenceId: seq.id, time: t, clipIds: [clip.id] }, 'Razor')); return; }
    const sel = new Set(p.selection); if (e.shiftKey) { sel.has(clip.id) ? sel.delete(clip.id) : sel.add(clip.id); } else if (!sel.has(clip.id)) { sel.clear(); sel.add(clip.id); } p.setSelection(sel);
    if (track.locked) { p.setHint(`Track ${track.name} is locked`); return; }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect(); const edge = Math.min(8, rect.width / 3);
    const mode = e.clientX - rect.left < edge ? 'start' : rect.right - e.clientX < edge ? 'end' : 'move';
    drag.current = { clipId: clip.id, mode, x0: e.clientX, y0: e.clientY, start: clip.start, end: clip.start + clip.duration, active: false, kind: track.kind, pending: null, busy: false, ok: true };
    const move = (ev: PointerEvent) => void onMove(ev); const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); void onUp(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const onMove = async (ev: PointerEvent) => {
    const d = drag.current; if (!d) return; const dx = ev.clientX - d.x0, dy = ev.clientY - d.y0;
    if (!d.active) { if (Math.abs(dx) + Math.abs(dy) < 4) return; d.active = true; try { p.setSnap(await api.gesture('begin', { key: d.mode, label: d.mode === 'move' ? 'Move clips' : d.mode === 'start' ? 'Trim start' : 'Trim end' })); } catch (e) { p.setHint(String(e)); drag.current = null; return; } }
    let delta = Math.round(dx / ppf);
    if (p.snapping) {
      const thr = 8 / ppf; const pts = snapPoints(group(findClip(d.clipId)!)); const cands = d.mode === 'move' ? [d.start + delta, d.end + delta] : d.mode === 'start' ? [d.start + delta] : [d.end + delta];
      let best: number | null = null; for (const c of cands) for (const s of pts) { const diff = s - c; if (Math.abs(diff) <= thr && (best === null || Math.abs(diff) < Math.abs(best))) best = diff; } if (best !== null) delta += best;
    }
    let cmd: Command;
    if (delta === 0 && Math.abs(dy) < 20) cmd = { type: 'edit.move', sequenceId: seq.id, clipIds: [d.clipId], deltaFrames: 0 };
    else if (d.mode === 'move') { const rowsMoved = Math.round(dy / 44); const trackDelta = d.kind === 'video' ? { video: -rowsMoved } : { audio: rowsMoved }; cmd = { type: 'edit.move', sequenceId: seq.id, clipIds: [d.clipId], deltaFrames: delta, trackDelta, mode: 'strict' }; }
    else cmd = delta === 0 ? { type: 'edit.move', sequenceId: seq.id, clipIds: [d.clipId], deltaFrames: 0 } : { type: 'edit.trim', sequenceId: seq.id, clipId: d.clipId, edge: d.mode, toTime: (d.mode === 'start' ? d.start : d.end) + delta, ripple: p.ripple };
    d.pending = cmd; void pump();
  };
  const onUp = async () => {
    const d = drag.current; drag.current = null; if (!d) return;
    if (!d.active) return; while (d.busy) await new Promise((r) => setTimeout(r, 5));
    try { p.setSnap(await api.gesture('commit')); } catch (e) { p.setHint(String(e)); try { p.setSnap(await api.gesture('cancel')); } catch { /* ignore */ } }
  };
  const findClip = (id: string) => rows.flatMap((t) => t.clips).find((c) => c.id === id);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && drag.current?.active) { drag.current.active = false; drag.current = null; void api.gesture('cancel').then(p.setSnap).catch(() => undefined); } }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); });

  const step = ppf >= 8 ? 5 : ppf >= 3 ? 25 : ppf >= 1 ? 125 : 500; const ticks: number[] = []; for (let f = 0; f <= end + 250; f += step) ticks.push(f);
  const tr = (patch: Partial<Track>, t: Track) => p.run(() => api.command({ type: 'track.set', sequenceId: seq.id, trackId: t.id, patch }, `Track ${t.name}`));
  return (
    <section className="panel timeline" data-testid="timeline">
      <header><h2>Timeline · {seq.name}</h2>
        <span className="muted">{seq.width}×{seq.height} · {(seq.rate.num / seq.rate.den).toFixed(3)} fps · {df ? 'DF' : 'NDF'} · {end} frames</span>
        <span className="spacer" /><button data-testid="zoom-out" onClick={() => setPpf((z) => Math.max(0.25, z / 1.5))}>−</button><button data-testid="zoom-in" onClick={() => setPpf((z) => Math.min(32, z * 1.5))}>＋</button></header>
      <div className="scroller" data-testid="timeline-scroll">
        <div className="content" style={{ width: width + HEADER_W }}>
          <div className="ruler-row"><div className="head corner" />
            <div className="ruler" style={{ width }} data-testid="ruler" onPointerDown={(e) => { const f = frameAt(e.clientX); transport.seek(f); const mv = (ev: PointerEvent) => transport.seek(frameAt(ev.clientX)); const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); }; window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); }}>
              {seq.inPoint !== null && seq.outPoint !== null && <div className="range" style={{ left: seq.inPoint * ppf, width: (seq.outPoint - seq.inPoint) * ppf }} />}
              {ticks.map((f) => <div key={f} className="tick" style={{ left: f * ppf }}>{framesToTimecode(f + seq.startFrame, { rate: seq.rate, dropFrame: df })}</div>)}
              {seq.markers.map((m) => <div key={m.id} className="marker" title={m.name} style={{ left: m.time * ppf }} data-testid="marker" />)}
            </div></div>
          <div className="rows" ref={undefined}>
            {rows.map((t) => (
              <div className="row" key={t.id} style={{ height: 44 }} data-testid={`row-${t.name}`}>
                <div className="head">
                  <b>{t.name}</b>
                  <button className={t.targeted ? 'on' : ''} title="Target track for insert/overwrite" data-testid={`target-${t.name}`} onClick={() => tr({ targeted: !t.targeted }, t)}>T</button>
                  <button className={t.locked ? 'on' : ''} title="Lock track" data-testid={`lock-${t.name}`} onClick={() => tr({ locked: !t.locked }, t)}>🔒</button>
                  <button className={t.syncLock ? 'on' : ''} title="Sync lock (ripple operations keep this track in sync)" data-testid={`sync-${t.name}`} onClick={() => tr({ syncLock: !t.syncLock }, t)}>S</button>
                  {t.kind === 'audio' ? <><button className={t.muted ? 'on' : ''} title="Mute (affects export; no audio preview in this build)" data-testid={`mute-${t.name}`} onClick={() => tr({ muted: !t.muted }, t)}>M</button>
                    <button className={t.solo ? 'on' : ''} title="Solo (affects export)" data-testid={`solo-${t.name}`} onClick={() => tr({ solo: !t.solo }, t)}>◎</button></>
                    : <button className={!t.visible ? 'on' : ''} title="Hide track output" data-testid={`vis-${t.name}`} onClick={() => tr({ visible: !t.visible }, t)}>{t.visible ? '👁' : '∅'}</button>}
                </div>
                <div className={`lane ${t.locked ? 'locked' : ''}`} style={{ width }} ref={t === rows[0] ? lanes : undefined}
                  onPointerDown={() => p.setSelection(new Set())}>
                  {t.clips.map((c) => {
                    const m = doc.mediaPool[c.mediaId]; const sel = p.selection.has(c.id) || [...p.selection].some((id) => { const o = findClip(id); return o && c.linkGroupId && o.linkGroupId === c.linkGroupId; });
                    return (
                      <div key={c.id} className={`clip ${t.kind} ${sel ? 'sel' : ''} ${c.linkGroupId ? 'linked' : ''} ${m && snap.mediaStatus[m.id] !== 'ok' ? 'offline' : ''}`} data-testid={`clip-${c.id}`}
                        data-start={c.start} data-dur={c.duration} data-track={t.name} data-media={m?.name} data-sourcein={c.sourceIn.ticks} style={{ left: c.start * ppf, width: Math.max(2, c.duration * ppf) }}
                        onPointerDown={(e) => onClipDown(e, c, t)} title={`${c.name} · ${c.start}→${c.start + c.duration}`}>
                        {t.kind === 'audio' && <Wave doc={doc} clip={c} seq={seq} ppf={ppf} />}
                        <span className="label">{c.name}</span>
                      </div>);
                  })}
                </div>
              </div>))}
            <div className="playhead" data-testid="playhead" style={{ left: HEADER_W + play * ppf }} />
          </div>
        </div>
      </div>
    </section>
  );
}
