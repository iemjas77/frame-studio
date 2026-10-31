import { Frac, Rate } from '@fs/timeline-model';
import { clipWithinSource } from './bounds.ts';
import type { ProjectDoc, Track } from './types.ts';

export interface Issue { severity: 'error' | 'warning'; code: string; path: string; message: string }

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const validRate = (r: Rate | undefined) => !!r && isInt(r.num) && isInt(r.den) && r.num > 0 && r.den > 0;

/** Structural + referential validation. Pure; never mutates. Errors make a project unloadable; warnings are surfaced. */
export function validateProject(p: ProjectDoc): Issue[] {
  const out: Issue[] = []; const err = (code: string, path: string, message: string) => out.push({ severity: 'error', code, path, message });
  const warn = (code: string, path: string, message: string) => out.push({ severity: 'warning', code, path, message });
  if (typeof p.id !== 'string' || !p.id) err('id.missing', 'id', 'project id missing');
  if (typeof p.mediaPool !== 'object' || !p.mediaPool || typeof p.sequences !== 'object' || !p.sequences || typeof p.bins !== 'object' || !p.bins) { err('shape', '', 'mediaPool/bins/sequences must be objects'); return out; }
  for (const [k, m] of Object.entries(p.mediaPool)) {
    const at = `mediaPool.${k}`;
    if (m.id !== k) err('id.mismatch', at, 'key differs from id');
    if (m.binId && !p.bins[m.binId]) err('ref.bin', at, `unknown bin ${m.binId}`);
    if (!m.video && !m.audio) warn('media.nostreams', at, 'media has no video or audio stream');
    if (m.video && (!validRate(m.video.rate) || !isInt(m.video.width) || !isInt(m.video.height))) err('media.video', at, 'invalid video info');
    if (m.audio && (!isInt(m.audio.sampleRate) || m.audio.sampleRate <= 0 || !isInt(m.audio.channels) || m.audio.channels <= 0)) err('media.audio', at, 'invalid audio info');
  }
  for (const id of p.mediaOrder) if (!p.mediaPool[id]) err('ref.mediaOrder', 'mediaOrder', `unknown media ${id}`);
  for (const [k, b] of Object.entries(p.bins)) {
    if (b.id !== k) err('id.mismatch', `bins.${k}`, 'key differs from id');
    if (b.parentId && !p.bins[b.parentId]) err('ref.bin', `bins.${k}`, `unknown parent ${b.parentId}`);
    const seen = new Set<string>(); let cur: string | null = b.parentId;
    while (cur) { if (cur === k || seen.has(cur)) { err('bin.cycle', `bins.${k}`, 'bin hierarchy contains a cycle'); break; } seen.add(cur); cur = p.bins[cur]?.parentId ?? null; }
  }
  const allIds = new Map<string, string>();
  const claim = (id: string, at: string) => { const prev = allIds.get(id); if (prev) err('id.duplicate', at, `id ${id} also used at ${prev}`); else allIds.set(id, at); };
  for (const [sk, s] of Object.entries(p.sequences)) {
    const sp = `sequences.${sk}`;
    if (s.id !== sk) err('id.mismatch', sp, 'key differs from id');
    if (!validRate(s.rate)) { err('seq.rate', sp, 'invalid frame rate'); continue; }
    if (!isInt(s.sampleRate) || s.sampleRate <= 0) err('seq.samplerate', sp, 'invalid sample rate');
    if (s.dropFrame && !(s.rate.den === 1001 && (s.rate.num === 30000 || s.rate.num === 60000))) err('seq.dropframe', sp, 'drop-frame requires 29.97 or 59.94');
    const linkMembers = new Map<string, { sp: string; c: import('./types.ts').Clip }[]>();
    const checkTracks = (tracks: Track[], kind: 'video' | 'audio') => tracks.forEach((t, ti) => {
      const tp = `${sp}.${kind}Tracks[${ti}]`; claim(t.id, tp);
      if (t.kind !== kind) err('track.kind', tp, `track kind ${t.kind} in ${kind} list`);
      let prevEnd = 0;
      t.clips.forEach((c, ci) => {
        const cp = `${tp}.clips[${ci}]`; claim(c.id, cp);
        if (!isInt(c.start) || c.start < 0) err('clip.start', cp, 'start must be a non-negative integer');
        if (!isInt(c.duration) || c.duration < 1) err('clip.duration', cp, 'duration must be an integer >= 1');
        if (c.start < prevEnd) err('clip.overlap', cp, `clip starts at ${c.start} before previous clip ends at ${prevEnd}`);
        prevEnd = c.start + c.duration;
        if (c.stream !== kind) err('clip.stream', cp, `${c.stream} clip on ${kind} track`);
        if (!c.speed || c.speed.num === 0 || c.speed.den <= 0) { err('clip.speed', cp, 'invalid speed'); return; }
        const m = p.mediaPool[c.mediaId];
        if (!m) err('ref.media', cp, `unknown media ${c.mediaId}`);
        else if (!clipWithinSource(c, s, m)) err('clip.sourcebounds', cp, 'clip references source outside the media duration (or media lacks the stream)');
        if (c.linkGroupId) { const a = linkMembers.get(c.linkGroupId) ?? []; a.push({ sp: cp, c }); linkMembers.set(c.linkGroupId, a); }
      });
    });
    checkTracks(s.videoTracks, 'video'); checkTracks(s.audioTracks, 'audio');
    for (const [g, ms] of linkMembers) if (ms.length < 2) warn('link.singleton', ms[0]!.sp, `link group ${g} has a single member`);
    s.markers.forEach((m, i) => { claim(m.id, `${sp}.markers[${i}]`); if (!isInt(m.time) || m.time < 0) err('marker.time', `${sp}.markers[${i}]`, 'marker time invalid'); });
    for (const [n, v] of [['inPoint', s.inPoint], ['outPoint', s.outPoint]] as const) if (v !== null && !isInt(v)) err('seq.range', sp, `${n} must be integer or null`);
    if (s.inPoint !== null && s.outPoint !== null && s.outPoint <= s.inPoint) err('seq.range', sp, 'outPoint must be after inPoint');
  }
  for (const id of p.sequenceOrder) if (!p.sequences[id]) err('ref.sequenceOrder', 'sequenceOrder', `unknown sequence ${id}`);
  if (p.activeSequenceId && !p.sequences[p.activeSequenceId]) err('ref.active', 'activeSequenceId', 'active sequence does not exist');
  return out;
}
export const hasErrors = (i: Issue[]): boolean => i.some((x) => x.severity === 'error');
void Frac;
