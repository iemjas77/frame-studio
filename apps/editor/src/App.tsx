import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FPS, time, convert, rate, framesToTimecode, type Rate } from '@fs/timeline-model';
import type { Sequence } from '@fs/project-model';
import { Transport, sequenceEnd } from '@fs/playback';
import { api, ApiError, type Snapshot } from './api.ts';
import { Monitor } from './Monitor.tsx';
import { Timeline, type Tool } from './Timeline.tsx';
import { ExportPanel, MediaPanel } from './Panels.tsx';
import { DEFAULT_KEYMAP, actionFor, chordFromEvent, type ActionId, type Keymap } from './keymap.ts';
import { Shortcuts } from './Shortcuts.tsx';

const loadKeymap = (): Keymap => { try { const raw = localStorage.getItem('fs.keymap'); if (raw) return { ...DEFAULT_KEYMAP, ...(JSON.parse(raw) as Partial<Keymap>) }; } catch { /* use default */ } return { ...DEFAULT_KEYMAP }; };

const isTyping = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable); };

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null); const [hint, setHint] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set()); const [tool, setTool] = useState<Tool>('select'); const [snapping, setSnapping] = useState(true); const [ripple, setRipple] = useState(false);
  const [focus, setFocus] = useState<'source' | 'program'>('program'); const [srcMedia, setSrcMedia] = useState<string | null>(null);
  const [srcIn, setSrcIn] = useState<number | null>(null); const [srcOut, setSrcOut] = useState<number | null>(null); const [only, setOnly] = useState<'both' | 'video' | 'audio'>('both');
  const snapRef = useRef<Snapshot | null>(null); snapRef.current = snap;

  const run = useCallback(async (fn: () => Promise<Snapshot>) => { try { const s = await fn(); setSnap(s); setHint(null); } catch (e) { setHint(e instanceof ApiError ? `${e.code}: ${e.message}` : String((e as Error).message ?? e)); } }, []);
  useEffect(() => { void run(api.state); }, [run]);
  useEffect(() => { const id = setInterval(() => { if (snapRef.current?.jobs.some((j) => !j.report)) void api.state().then(setSnap).catch(() => undefined); }, 400); return () => clearInterval(id); }, []);

  const doc = snap?.project; const seq: Sequence | undefined = doc && doc.activeSequenceId ? doc.sequences[doc.activeSequenceId] : undefined;
  const duration = seq ? sequenceEnd(seq) : 0; const durRef = useRef(0); durRef.current = duration;
  const program = useMemo(() => new Transport({ rate: seq?.rate ?? FPS.f25, duration: () => durRef.current, now: () => performance.now() }), [seq?.id, seq?.rate.num, seq?.rate.den]);
  const media = srcMedia && doc ? doc.mediaPool[srcMedia] : undefined; const srcRate: Rate = media?.video?.rate ?? FPS.f25;
  const srcDur = media?.video ? media.video.duration.ticks : media?.audio ? Math.floor((media.audio.duration.ticks / media.audio.sampleRate) * 25) : 0;
  const srcDurRef = useRef(0); srcDurRef.current = srcDur;
  const source = useMemo(() => new Transport({ rate: srcRate, duration: () => srcDurRef.current, now: () => performance.now() }), [srcMedia, srcRate.num, srcRate.den]);
  useEffect(() => { setSrcIn(null); setSrcOut(null); }, [srcMedia]);
  const mon = focus === 'source' ? source : program;

  const insertLike = (type: 'edit.insert' | 'edit.overwrite') => {
    if (!seq || !media) { setHint('Load a clip in the Source monitor first (click it in the Project panel)'); return; }
    const vr = media.video?.rate; const toTime = (f: number | null) => (f === null ? undefined : media.video ? time(f, vr!) : convert(time(f, rate(25)), rate(media.audio!.sampleRate), 'nearest'));
    const outEx = srcOut === null ? undefined : toTime(srcOut + 1); // out point is inclusive in the UI; the model uses an exclusive end
    void run(() => api.command({ type, sequenceId: seq.id, mediaId: media.id, time: program.position(), sourceIn: toTime(srcIn), sourceOut: outEx, only }, type === 'edit.insert' ? 'Insert' : 'Overwrite'));
  };
  const selIds = () => [...selection];
  const act = {
    undo: () => run(api.undo), redo: () => run(api.redo), save: () => run(api.save),
    razorAtPlayhead: () => seq && run(() => api.command({ type: 'edit.split', sequenceId: seq.id, time: program.position(), allTracks: true }, 'Add edit')),
    lift: () => seq && selIds().length && run(() => api.command({ type: 'edit.lift', sequenceId: seq.id, clipIds: selIds() }, 'Lift')),
    rippleDelete: () => seq && selIds().length && run(() => api.command({ type: 'edit.rippleDelete', sequenceId: seq.id, clipIds: selIds() }, 'Ripple delete')),
    marker: () => seq && run(() => api.command({ type: 'marker.add', sequenceId: seq.id, marker: { time: program.position(), duration: 0, name: 'Marker', color: 'amber', comment: '' } }, 'Add marker')),
    markIn: () => (focus === 'source' ? setSrcIn(source.position()) : seq && run(() => api.command({ type: 'sequence.setRange', sequenceId: seq.id, inPoint: program.position(), outPoint: seq.outPoint !== null && seq.outPoint > program.position() ? seq.outPoint : null }, 'Mark in'))),
    markOut: () => (focus === 'source' ? setSrcOut(source.position()) : seq && run(() => api.command({ type: 'sequence.setRange', sequenceId: seq.id, inPoint: seq.inPoint !== null && seq.inPoint < program.position() ? seq.inPoint : null, outPoint: program.position() + 1 }, 'Mark out'))),
    clearMarks: () => (focus === 'source' ? (setSrcIn(null), setSrcOut(null)) : seq && run(() => api.command({ type: 'sequence.setRange', sequenceId: seq.id, inPoint: null, outPoint: null }, 'Clear range'))),
  };
  const actRef = useRef(act); actRef.current = act;
  const [keymap, setKeymapState] = useState<Keymap>(loadKeymap); const [showKeys, setShowKeys] = useState(false);
  const keymapRef = useRef(keymap); keymapRef.current = keymap; const setKeymap = (m: Keymap) => { setKeymapState(m); try { localStorage.setItem('fs.keymap', JSON.stringify(m)); } catch { /* storage unavailable */ } };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || showKeys) return;               // shortcuts never fire in text fields or while the shortcut dialog is open
      const chord = chordFromEvent(e); if (!chord) return; const action = actionFor(keymapRef.current, chord); if (!action) return;
      const a = actRef.current; const t = mon;
      const table: Record<ActionId, () => void> = {
        undo: () => void a.undo(), redo: () => void a.redo(), save: () => void a.save(), import: () => document.querySelector<HTMLTextAreaElement>('[data-testid=import-paths]')?.focus(), addEdit: () => void a.razorAtPlayhead(),
        playPause: () => (t.state === 'playing' ? t.pause() : t.play()), shuttleBack: () => t.shuttle('J'), pause: () => t.shuttle('K'), shuttleFwd: () => t.shuttle('L'),
        stepBack: () => void t.step(-1), stepFwd: () => void t.step(1), stepBack5: () => void t.step(-5), stepFwd5: () => void t.step(5), toStart: () => void t.seek(0), toEnd: () => void t.seek(10 ** 9),
        markIn: () => void a.markIn(), markOut: () => void a.markOut(), clearMarks: () => void a.clearMarks(), marker: () => void a.marker(), toolSelect: () => setTool('select'), toolRazor: () => setTool('razor'),
        insert: () => insertLike('edit.insert'), overwrite: () => insertLike('edit.overwrite'), lift: () => void a.lift(), rippleDelete: () => void a.rippleDelete(),
      };
      e.preventDefault(); table[action]();
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });

  if (!snap || !doc) return <div className="boot">{hint ?? 'Loading Frame Studio…'}</div>;
  const rec = snap.recovery;
  return (
    <div className="app" data-testid="app">
      <header className="topbar">
        <div className="brand"><svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true"><rect x="3" y="5" width="26" height="22" rx="5" fill="none" stroke="#37c8b4" strokeWidth="3" /><path d="M13 11l8 5-8 5z" fill="#f2b34a" /></svg> Frame Studio <span className="muted ver">0.1 · engineering preview</span></div>
        <div className="tools">
          <button className={tool === 'select' ? 'on' : ''} onClick={() => setTool('select')} title="Selection (V)" data-testid="tool-select">Select</button>
          <button className={tool === 'razor' ? 'on' : ''} onClick={() => setTool('razor')} title="Razor (C)" data-testid="tool-razor">Razor</button>
          <button className={snapping ? 'on' : ''} onClick={() => setSnapping(!snapping)} title="Snapping" data-testid="btn-snap">Snap</button>
          <button className={ripple ? 'on' : ''} onClick={() => setRipple(!ripple)} title="Ripple trims" data-testid="btn-ripple">Ripple trim</button>
          <span className="sep" />
          <select value={only} onChange={(e) => setOnly(e.target.value as typeof only)} aria-label="Insert tracks" data-testid="sel-only"><option value="both">V + A</option><option value="video">Video only</option><option value="audio">Audio only</option></select>
          <button onClick={() => insertLike('edit.insert')} title="Insert (,)" data-testid="btn-insert">Insert</button>
          <button onClick={() => insertLike('edit.overwrite')} title="Overwrite (.)" data-testid="btn-overwrite">Overwrite</button>
          <button onClick={() => act.razorAtPlayhead()} title="Add edit at playhead on all unlocked tracks (Ctrl+K)" data-testid="btn-addedit">Add edit</button>
          <button onClick={() => act.lift()} title="Lift (Delete)" data-testid="btn-lift">Lift</button>
          <button onClick={() => act.rippleDelete()} title="Ripple delete (Shift+Delete)" data-testid="btn-rippledelete">Ripple delete</button>
          <button onClick={() => act.marker()} title="Marker (M)" data-testid="btn-marker">Marker</button>
          <span className="sep" />
          <button disabled={!snap.canUndo} onClick={() => act.undo()} title={`Undo ${snap.undoLabel ?? ''} (Ctrl+Z)`} data-testid="btn-undo">Undo</button>
          <button disabled={!snap.canRedo} onClick={() => act.redo()} title={`Redo ${snap.redoLabel ?? ''} (Ctrl+Shift+Z)`} data-testid="btn-redo">Redo</button>
          <button onClick={() => act.save()} title="Save (Ctrl+S)" data-testid="btn-save">Save{snap.dirty ? ' ●' : ''}</button>
          <button onClick={() => setShowKeys(true)} title="Keyboard shortcuts" data-testid="btn-shortcuts">Shortcuts</button>
        </div>
      </header>
      {(rec.journalReplayed > 0 || rec.source !== 'main' && rec.source !== 'new' || rec.journalSkippedReason) && (
        <div className="banner" data-testid="recovery-banner">Recovered from {rec.source}{rec.journalReplayed ? ` and replayed ${rec.journalReplayed} unsaved edit(s)` : ''}{rec.journalDropped ? ' (a partially written final entry was discarded)' : ''}. {rec.journalSkippedReason ?? ''} Save to keep it.</div>)}
      <main className="grid">
        <MediaPanel snap={snap} selectedId={srcMedia} onSelect={(id) => { setSrcMedia(id); setFocus('source'); }} run={run} setSnap={setSnap} setHint={setHint} />
        <Monitor id="source" title={media ? `Source · ${media.name}` : 'Source'} transport={source} rate={srcRate} dropFrame={false} startFrame={0} duration={srcDur} focused={focus === 'source'} onFocus={() => setFocus('source')}
          frameUrl={(f, g) => (media?.video && snap.mediaStatus[media.id] === 'ok' ? api.frameUrl('media', media.id, f, g, 'source') : null)} refreshKey={media?.id ?? ''} inPoint={srcIn} outPoint={srcOut}
          empty={!media ? 'Select a clip in the Project panel' : !media.video ? 'Audio-only clip (no picture)' : snap.mediaStatus[media.id] !== 'ok' ? 'Media offline' : undefined} />
        {seq ? <Monitor id="program" title="Program" transport={program} rate={seq.rate} dropFrame={seq.dropFrame} startFrame={seq.startFrame} duration={duration} focused={focus === 'program'} onFocus={() => setFocus('program')}
          frameUrl={(f, g) => api.frameUrl('program', seq.id, f, g, 'program')} refreshKey={snap.revision} inPoint={seq.inPoint} outPoint={seq.outPoint} /> : <section className="panel" />}
        <ExportPanel snap={snap} seqId={seq?.id ?? ''} setSnap={setSnap} />
        {seq && <Timeline snap={snap} seq={seq} transport={program} selection={selection} setSelection={setSelection} tool={tool} snapping={snapping} ripple={ripple} run={run} setHint={setHint} setSnap={setSnap} playhead={0} />}
      </main>
      {showKeys && <Shortcuts map={keymap} setMap={setKeymap} close={() => setShowKeys(false)} />}
      <footer className="status" data-testid="status"><span data-testid="hint" className={hint ? 'warn' : 'muted'}>{hint ?? 'Ready'}</span><span className="muted">Rev {snap.revision} · {snap.file} · {focus} monitor focused · audio preview not available in this build</span></footer>
    </div>
  );
}
void framesToTimecode;
