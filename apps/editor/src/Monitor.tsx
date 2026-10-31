import React, { useEffect, useRef, useState } from 'react';
import { framesToTimecode, supportsDropFrame, type Rate } from '@fs/timeline-model';
import type { Transport } from '@fs/playback';
import { fetchFrame } from './api.ts';

export interface MonitorProps {
  id: 'source' | 'program'; title: string; transport: Transport; rate: Rate; dropFrame: boolean; startFrame: number; duration: number;
  frameUrl: (frame: number, gen: number) => string | null; refreshKey: string | number; focused: boolean; onFocus: () => void;
  inPoint: number | null; outPoint: number | null; empty?: string; onSeekUi?: (f: number) => void;
}

/** Shows frames for the latest transport generation only: a result for an older seek/play generation is never drawn. */
export function Monitor(p: MonitorProps) {
  const canvas = useRef<HTMLCanvasElement>(null); const [pos, setPos] = useState(0); const [playing, setPlaying] = useState(false); const [dropped, setDropped] = useState(0);
  const [info, setInfo] = useState(''); const [safe, setSafe] = useState(false); const [loop, setLoop] = useState(false); const [err, setErr] = useState<string | null>(null);
  const lp = useRef<{ start: number; end: number } | null>(null);
  lp.current = loop ? { start: p.inPoint ?? 0, end: p.outPoint ?? p.duration } : null;
  const props = useRef(p); props.current = p;
  useEffect(() => {
    p.transport.setLoopProvider(() => (lp.current && lp.current.end > lp.current.start ? lp.current : null));
  }, [p.transport]);
  useEffect(() => {
    let raf = 0; let key = ''; let inflight = false; let ctl: AbortController | null = null; let dead = false; const t = p.transport;
    const request = (frame: number, gen: number) => {
      const url = props.current.frameUrl(frame, gen); const c = canvas.current; if (!c) return;
      if (!url) { c.getContext('2d')?.clearRect(0, 0, c.width, c.height); setInfo(''); return; }
      ctl?.abort(); ctl = new AbortController(); inflight = true;
      fetchFrame(url, ctl.signal).then((r) => {
        inflight = false; if (dead || !r) return;
        if (!t.present(gen, frame)) { r.bitmap.close(); return; }          // stale generation: discard
        c.width = r.bitmap.width; c.height = r.bitmap.height; c.getContext('2d')!.drawImage(r.bitmap, 0, 0); r.bitmap.close(); c.dataset.shown = String(frame); c.dataset.source = r.source ?? ''; setInfo(r.source ?? ''); setErr(null);
      }).catch((e) => { inflight = false; if (!dead) setErr(String(e.message ?? e)); });
    };
    const tick = () => {
      const frame = t.position(); const gen = t.generation; setPos((x) => (x === frame ? x : frame)); setPlaying(t.state === 'playing'); setDropped(t.dropped);
      const k = `${frame}|${gen}|${props.current.refreshKey}`;
      if (k !== key && (!inflight || t.state !== 'playing')) { key = k; request(frame, gen); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick); return () => { dead = true; cancelAnimationFrame(raf); ctl?.abort(); };
  }, [p.transport]);
  const dfOk = p.dropFrame && supportsDropFrame(p.rate);
  const tc = framesToTimecode(pos + p.startFrame, { rate: p.rate, dropFrame: dfOk });
  const t = p.transport;
  return (
    <section className={`panel monitor ${p.focused ? 'focused' : ''}`} data-testid={`monitor-${p.id}`} onPointerDown={p.onFocus}>
      <header><h2>{p.title}</h2><span className="tc" data-testid={`tc-${p.id}`}>{tc}</span><span className="muted" data-testid={`pos-${p.id}`}>{pos}</span></header>
      <div className="screen">
        {p.empty ? <div className="empty">{p.empty}</div> : <canvas ref={canvas} data-testid={`canvas-${p.id}`} />}
        {safe && <div className="safe"><div className="action" /><div className="title" /></div>}
        {err && <div className="err">{err}</div>}
      </div>
      <input type="range" min={0} max={Math.max(0, p.duration - 1)} value={Math.min(pos, Math.max(0, p.duration - 1))} aria-label={`${p.title} scrub`} data-testid={`scrub-${p.id}`}
        onChange={(e) => { t.seek(Number(e.target.value)); p.onSeekUi?.(Number(e.target.value)); }} />
      <div className="controls">
        <button title="Previous frame (Left)" data-testid={`prev-${p.id}`} onClick={() => t.step(-1)}>|◀</button>
        <button title="Play / Pause (Space)" data-testid={`play-${p.id}`} onClick={() => (t.state === 'playing' ? t.pause() : t.play())}>{playing ? '❚❚' : '▶'}</button>
        <button title="Next frame (Right)" data-testid={`next-${p.id}`} onClick={() => t.step(1)}>▶|</button>
        <label title="Loop between in and out"><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} data-testid={`loop-${p.id}`} /> loop</label>
        <label><input type="checkbox" checked={safe} onChange={(e) => setSafe(e.target.checked)} data-testid={`safe-${p.id}`} /> safe areas</label>
        <span className="muted" data-testid={`dropped-${p.id}`} title="Frames not presented during playback (decode too slow)">dropped {dropped}</span>
        <span className="muted src" data-testid={`src-${p.id}`}>{info}</span>
      </div>
      <div className="marks muted">In {p.inPoint ?? '–'} · Out {p.outPoint ?? '–'} · speed {playing ? `${t.direction * t.speed}x` : '0x'}</div>
    </section>
  );
}
