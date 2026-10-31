/**
 * Editorial semantics. Functions mutate an immer draft of a Sequence and throw CommandError on any
 * violated precondition; the engine discards the draft, so every command is atomic.
 *
 * Reference semantics (also documented in docs/specifications/timeline-semantics.md):
 *  - Clips on a track never overlap; intervals are half-open; gaps are implicit.
 *  - "Affected" (rippling) tracks = unlocked tracks with syncLock, plus any track a command explicitly targets/edits.
 *  - A LOCKED track with syncLock that holds content after the edit point makes ripple/insert FAIL (LockedTrackConflict):
 *    we never silently let it drift out of sync. A locked track with syncLock=false is untouched by design.
 *  - Link groups: commands apply to all members of each selected clip's group unless ignoreLinks.
 */
import { Frac, NORMAL_SPEED, Rate, Time, convert, rateFrac, seconds, sourceSecondsAt, sourceSpan, time, toSafeInt } from '@fs/timeline-model';
import { Clip, Id, MediaRef, Sequence, Track, clipWithinSource, streamDuration, sourceTolerance, syncOffset } from '@fs/project-model';
import { Ctx, plain } from './ctx.ts';
import { fail } from './errors.ts';

export const tracksOf = (s: Sequence): Track[] => [...s.videoTracks, ...s.audioTracks];
export function findTrack(s: Sequence, id: Id): Track { return tracksOf(s).find((t) => t.id === id) ?? fail('NotFound', `track ${id} not found`); }
export function findClip(s: Sequence, id: Id): { track: Track; clip: Clip; index: number } {
  for (const track of tracksOf(s)) { const index = track.clips.findIndex((c) => c.id === id); if (index >= 0) return { track, clip: track.clips[index]!, index }; }
  return fail('NotFound', `clip ${id} not found`);
}
export const endOf = (c: Clip): number => c.start + c.duration;
const sortClips = (t: Track) => { t.clips.sort((a, b) => a.start - b.start); };
const assertUnlocked = (t: Track, what: string) => { if (t.locked) fail('LockedTrack', `track ${t.name} is locked (${what})`, { trackId: t.id }); };
const intOk = (v: number, what: string, min = 0) => { if (!Number.isSafeInteger(v) || v < min) fail('InvalidArgument', `${what} must be an integer >= ${min} (got ${v})`); };

/** Express an exact source instant as a Time: in the media's native domain if exact, else as an exact rational domain. */
export function normalizeSource(sec: Frac, nativeRate: Rate): Time {
  const ticks = sec.mul(rateFrac(nativeRate));
  if (ticks.isInteger()) return time(toSafeInt(ticks.n), nativeRate);
  return time(toSafeInt(sec.n, 'source ticks'), { num: toSafeInt(sec.d, 'source rate'), den: 1 });
}
const nativeRateOf = (m: MediaRef, stream: 'video' | 'audio'): Rate => (stream === 'video' ? m.video!.rate : { num: m.audio!.sampleRate, den: 1 });

export function sourceAtBoundary(seq: Sequence, media: MediaRef, c: Clip, boundary: number): Time {
  const sec = sourceSecondsAt({ start: c.start, sourceIn: c.sourceIn, speed: c.speed, seqRate: seq.rate }, Frac.of(boundary));
  return normalizeSource(sec, nativeRateOf(media, c.stream));
}

export interface Edit { seq: Sequence; media: (id: Id) => MediaRef; ctx: Ctx }
const mediaOf = (e: Edit, c: Clip): MediaRef => e.media(c.mediaId);

/** Links: all members of the groups of `ids` (or just ids when ignoreLinks). */
export function expandLinked(s: Sequence, ids: Id[], ignoreLinks = false): Clip[] {
  const out = new Map<Id, Clip>();
  for (const id of ids) {
    const { clip } = findClip(s, id); out.set(clip.id, clip);
    if (!ignoreLinks && clip.linkGroupId) for (const t of tracksOf(s)) for (const c of t.clips) if (c.linkGroupId === clip.linkGroupId) out.set(c.id, c);
  }
  return [...out.values()];
}

/* ------------------------------------------------------------------ splitting / clearing */
type GroupMap = Map<Id, Id>;
function splitAt(e: Edit, track: Track, clip: Clip, t: number, groups: GroupMap): Clip {
  if (!(t > clip.start && t < endOf(clip))) fail('InvalidArgument', `split time ${t} not strictly inside clip ${clip.id} [${clip.start},${endOf(clip)})`);
  const right: Clip = plain(clip); right.id = e.ctx.newId('clip'); right.start = t; right.duration = endOf(clip) - t;
  right.sourceIn = sourceAtBoundary(e.seq, mediaOf(e, clip), clip, t);
  if (clip.linkGroupId) { if (!groups.has(clip.linkGroupId)) groups.set(clip.linkGroupId, e.ctx.newId('link')); right.linkGroupId = groups.get(clip.linkGroupId)!; }
  clip.duration = t - clip.start;
  track.clips.push(right); sortClips(track); return right;
}
function trimHead(e: Edit, clip: Clip, newStart: number) {
  const src = sourceAtBoundary(e.seq, mediaOf(e, clip), clip, newStart);
  clip.duration = endOf(clip) - newStart; clip.start = newStart; clip.sourceIn = src;
}
/** Remove [a,b) from a track, splitting/trimming clips; returns nothing. Track must be unlocked (caller checks). */
function clearRange(e: Edit, track: Track, a: number, b: number, groups: GroupMap): void {
  for (const c of [...track.clips]) {
    const s = c.start, en = endOf(c);
    if (en <= a || s >= b) continue;
    if (s >= a && en <= b) { track.clips.splice(track.clips.indexOf(c), 1); continue; }
    if (s < a && en > b) { splitAt(e, track, c, b, groups); c.duration = a - c.start; continue; } // left part keeps c, right part is new
    if (s < a) c.duration = a - s; else trimHead(e, c, b);
  }
  sortClips(track);
}

/**
 * Link groups are SYNC groups: every member has the same sync offset (sequence time minus source time).
 * When an operation shifts or splits only part of a group, the pieces that are no longer in sync with the
 * largest in-sync cluster are moved to a new group (or unlinked when alone). We dissolve rather than keep a hidden
 * offset; an "out-of-sync, still linked" model like Premiere's badge is a possible later policy.
 */
export function normalizeLinks(e: Edit): void {
  const tol = Frac.of(1, 2 * 48000); const byGroup = new Map<Id, Clip[]>();
  for (const t of tracksOf(e.seq)) for (const c of t.clips) if (c.linkGroupId) byGroup.set(c.linkGroupId, [...(byGroup.get(c.linkGroupId) ?? []), c]);
  for (const [gid, members] of byGroup) {
    const clusters: { off: Frac; cs: Clip[] }[] = [];
    for (const c of members) { const off = syncOffset(c, e.seq.rate); const hit = clusters.find((k) => { const d = k.off.sub(off); return (d.n < 0n ? d.neg() : d).cmp(tol) <= 0; }); if (hit) hit.cs.push(c); else clusters.push({ off, cs: [c] }); }
    if (clusters.length === 1 && members.length > 1) continue;
    let keep = clusters[0]!; for (const k of clusters) if (k.cs.length > keep.cs.length) keep = k;
    for (const k of clusters) {
      if (k === keep) { if (k.cs.length < 2) for (const c of k.cs) delete c.linkGroupId; continue; }
      if (k.cs.length < 2) { for (const c of k.cs) delete c.linkGroupId; continue; }
      const ng = e.ctx.newId('link'); for (const c of k.cs) c.linkGroupId = ng;
    }
    void gid;
  }
}

/* ------------------------------------------------------------------ rippling */
function rippleTracks(e: Edit, extra: Track[], at: number): Track[] {
  const set = new Set<Track>(extra);
  for (const t of tracksOf(e.seq)) {
    if (!t.syncLock || set.has(t)) continue;
    if (t.locked) { if (t.clips.some((c) => endOf(c) > at)) fail('LockedTrackConflict', `locked sync-locked track ${t.name} has content after ${at}; unlock it or disable its sync lock`, { trackId: t.id }); continue; }
    set.add(t);
  }
  for (const t of set) assertUnlocked(t, 'ripple');
  return [...set];
}
/** Open a gap of `len` at `at` on tracks: spanning clips are split, later clips shift right. */
function openGap(e: Edit, tracks: Track[], at: number, len: number, groups: GroupMap) {
  for (const t of tracks) {
    for (const c of [...t.clips]) if (c.start < at && endOf(c) > at) splitAt(e, t, c, at, groups);
    for (const c of t.clips) if (c.start >= at) c.start += len;
  }
}
function maxLeftShift(t: Track, a: number, b: number, want: number): number {
  // any remaining clip overlapping the vacated region [a,b) cannot be shifted and would be left out of sync -> blocked
  if (t.clips.some((c) => c.start < b && endOf(c) > a)) return 0;
  let first = Infinity, prevEnd = 0;
  for (const c of t.clips) { if (c.start >= b) first = Math.min(first, c.start); else prevEnd = Math.max(prevEnd, endOf(c)); }
  return first === Infinity ? want : Math.max(0, Math.min(want, first - prevEnd));
}
/** Close the (already empty on the removed track) region [a,b): shifts later content left on affected tracks. */
function closeGap(e: Edit, tracks: Track[], a: number, b: number, allowPartial: boolean): number {
  const want = b - a; let d = want;
  for (const t of tracks) d = Math.min(d, maxLeftShift(t, a, b, want));
  if (d < want && !allowPartial) {
    const blocker = tracks.find((t) => maxLeftShift(t, a, b, want) < want)!;
    fail('RippleBlocked', `ripple of ${want} frames blocked on track ${blocker.name} (room for ${d}); content there would collide`, { trackId: blocker.id, possible: d });
  }
  if (d > 0) for (const t of tracks) for (const c of t.clips) if (c.start >= b) c.start -= d;
  return d;
}

/* ------------------------------------------------------------------ source range helpers */
export interface SourceSel { in?: Time; out?: Time }
export interface Placement { track: Track; clip: Clip }

/** Build clips for media at sequence time t. Duration in frames never exceeds any used stream (floor). */
export function buildClips(e: Edit, mediaId: Id, t: number, sel: SourceSel, targets: { video?: Id | null; audio?: Id | null }, only: 'both' | 'video' | 'audio'): Placement[] {
  const m = e.media(mediaId); const useV = !!m.video && only !== 'audio'; const useA = !!m.audio && only !== 'video';
  if (!useV && !useA) fail('NoTarget', `media ${m.name} has no ${only === 'both' ? 'video or audio' : only} stream to place`);
  const lead = useV ? m.video! : m.audio!;
  const inSec = sel.in ? seconds(sel.in) : Frac.of(0);
  const total = (useV ? streamDuration(m, 'video')! : null); void lead;
  let avail: Frac | null = null;
  for (const st of [useV ? 'video' : null, useA ? 'audio' : null] as const) {
    if (!st) continue; const d = streamDuration(m, st)!; avail = avail && avail.cmp(d) < 0 ? avail : d;
  }
  void total;
  const outSec = sel.out ? seconds(sel.out) : avail!;
  if (inSec.cmp(Frac.of(0)) < 0) fail('InvalidArgument', 'source in point is before the start of the media');
  if (outSec.cmp(inSec) <= 0) fail('InvalidArgument', 'source out must be after source in');
  const tol = Frac.of(0);
  if (outSec.cmp(avail!.add(tol)) > 0) fail('InsufficientHandle', 'source out point is beyond the end of the media');
  const dur = toSafeInt(outSec.sub(inSec).mul(rateFrac(e.seq.rate)).floor(), 'duration');
  if (dur < 1) fail('InvalidArgument', 'selected source range is shorter than one sequence frame');
  const link = useV && useA ? e.ctx.newId('link') : undefined;
  const out: Placement[] = [];
  const mk = (stream: 'video' | 'audio', trackId: Id): Placement => {
    const track = findTrack(e.seq, trackId); if (track.kind !== stream) fail('InvalidArgument', `${stream} clip cannot go on ${track.kind} track ${track.name}`);
    let srcIn: Time;
    if (stream === 'video') srcIn = sel.in ? convert(sel.in, m.video!.rate, 'nearest') : time(0, m.video!.rate);
    else srcIn = normalizeSource(inSec, { num: m.audio!.sampleRate, den: 1 });
    // audio in-point is derived from the exact (frame-snapped when video present) instant so linked clips share one sync offset
    if (stream === 'audio' && useV) srcIn = normalizeSource(seconds(convert(sel.in ?? time(0, m.video!.rate), m.video!.rate, 'nearest')), { num: m.audio!.sampleRate, den: 1 });
    const clip: Clip = { id: e.ctx.newId('clip'), name: m.name, mediaId, stream, start: t, duration: dur, sourceIn: srcIn, speed: NORMAL_SPEED, enabled: true };
    if (link) clip.linkGroupId = link;
    if (!clipWithinSource(clip, e.seq, m)) fail('InsufficientHandle', `${stream} stream of ${m.name} is too short for the selected range`);
    return { track, clip };
  };
  const defTrack = (kind: 'video' | 'audio') => (kind === 'video' ? e.seq.videoTracks : e.seq.audioTracks).find((x) => x.targeted)?.id;
  if (useV) { const id = targets.video ?? defTrack('video'); if (!id) fail('NoTarget', 'no destination video track targeted'); out.push(mk('video', id!)); }
  if (useA) { const id = targets.audio ?? defTrack('audio'); if (!id) fail('NoTarget', 'no destination audio track targeted'); out.push(mk('audio', id!)); }
  return out;
}

/* ------------------------------------------------------------------ operations */
export function insertClips(e: Edit, t: number, places: Placement[]): void {
  intOk(t, 'time'); const len = places[0]!.clip.duration;
  for (const p of places) assertUnlocked(p.track, 'insert target');
  const tracks = rippleTracks(e, places.map((p) => p.track), t);
  openGap(e, tracks, t, len, new Map());
  for (const p of places) { p.track.clips.push(p.clip); sortClips(p.track); }
  normalizeLinks(e);
  e.ctx.touch(e.seq.id, t, Math.max(t + len, ...tracksOf(e.seq).flatMap((x) => x.clips.map(endOf))));
}
export function overwriteClips(e: Edit, t: number, places: Placement[]): void {
  intOk(t, 'time'); const len = places[0]!.clip.duration; const groups: GroupMap = new Map();
  for (const p of places) assertUnlocked(p.track, 'overwrite target');
  for (const p of places) clearRange(e, p.track, t, t + len, groups);
  for (const p of places) { p.track.clips.push(p.clip); sortClips(p.track); }
  e.ctx.touch(e.seq.id, t, t + len);
}
export function appendTime(e: Edit, places: Placement[]): number { return Math.max(0, ...places.map((p) => Math.max(0, ...p.track.clips.map(endOf)))); }

export function splitClips(e: Edit, t: number, target: { clipIds?: Id[]; allTracks?: boolean; ignoreLinks?: boolean }): Id[] {
  intOk(t, 'time'); const groups: GroupMap = new Map(); const created: Id[] = [];
  let victims: { track: Track; clip: Clip }[] = [];
  if (target.clipIds?.length) {
    for (const c of expandLinked(e.seq, target.clipIds, target.ignoreLinks)) victims.push(findClip(e.seq, c.id));
    for (const v of victims) { assertUnlocked(v.track, 'split'); }
    victims = victims.filter((v) => v.clip.start < t && endOf(v.clip) > t);
    if (!victims.length) fail('NothingToDo', `time ${t} is not inside any selected clip`);
  } else if (target.allTracks) {
    for (const tr of tracksOf(e.seq)) if (!tr.locked) for (const clip of tr.clips) if (clip.start < t && endOf(clip) > t) victims.push({ track: tr, clip });
    if (!victims.length) fail('NothingToDo', `no unlocked clip spans time ${t}`);
  } else fail('InvalidArgument', 'split needs clipIds or allTracks');
  for (const v of victims) created.push(splitAt(e, v.track, v.clip, t, groups).id);
  e.ctx.touch(e.seq.id, t, t + 1); return created;
}

export function liftClips(e: Edit, ids: Id[], ignoreLinks?: boolean): void {
  const cs = expandLinked(e.seq, ids, ignoreLinks); let lo = Infinity, hi = 0;
  for (const c of cs) { const { track } = findClip(e.seq, c.id); assertUnlocked(track, 'lift'); lo = Math.min(lo, c.start); hi = Math.max(hi, endOf(c)); }
  for (const c of cs) { const { track, index } = findClip(e.seq, c.id); track.clips.splice(index, 1); }
  e.ctx.touch(e.seq.id, lo, hi);
}

/** Ripple delete: delete clips and close the vacated time on every affected track. Strict unless allowPartial. */
export function rippleDeleteClips(e: Edit, ids: Id[], opts: { ignoreLinks?: boolean; allowPartial?: boolean }): number[] {
  const cs = expandLinked(e.seq, ids, opts.ignoreLinks); const own: Track[] = []; const spans: [number, number][] = [];
  for (const c of cs) { const { track } = findClip(e.seq, c.id); assertUnlocked(track, 'ripple delete'); if (!own.includes(track)) own.push(track); spans.push([c.start, endOf(c)]); }
  spans.sort((a, b) => a[0] - b[0]); const regions: [number, number][] = [];
  for (const s of spans) { const last = regions[regions.length - 1]; if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else regions.push([...s]); }
  const tracks = rippleTracks(e, own, regions[0]![0]);
  for (const c of cs) { const { track, index } = findClip(e.seq, c.id); track.clips.splice(index, 1); }
  const shifted: number[] = [];
  for (const [a, b] of regions.reverse()) shifted.push(closeGap(e, tracks, a, b, !!opts.allowPartial));
  normalizeLinks(e);
  e.ctx.touch(e.seq.id, regions[regions.length - 1]![0], Math.max(...tracksOf(e.seq).flatMap((x) => x.clips.map(endOf)), 0));
  return shifted;
}

/** Remove the empty gap on `trackId` that contains `t` by rippling later content left. */
export function removeGap(e: Edit, trackId: Id, t: number, allowPartial?: boolean): number {
  const tr = findTrack(e.seq, trackId); assertUnlocked(tr, 'remove gap');
  if (tr.clips.some((c) => c.start <= t && t < endOf(c))) fail('InvalidArgument', `time ${t} is not inside a gap on ${tr.name}`);
  const prevEnd = Math.max(0, ...tr.clips.filter((c) => endOf(c) <= t).map(endOf));
  const next = tr.clips.filter((c) => c.start > t).map((c) => c.start); if (!next.length) fail('NothingToDo', 'gap runs to the end of the track; nothing to close');
  const b = Math.min(...next); const tracks = rippleTracks(e, [tr], prevEnd);
  const d = closeGap(e, tracks, prevEnd, b, !!allowPartial); normalizeLinks(e); e.ctx.touch(e.seq.id, prevEnd, b); return d;
}

export interface MoveSpec { clipIds: Id[]; deltaFrames: number; trackDelta?: { video?: number; audio?: number }; mode?: 'strict' | 'overwrite'; ignoreLinks?: boolean }
export function moveClips(e: Edit, m: MoveSpec): void {
  const cs = expandLinked(e.seq, m.clipIds, m.ignoreLinks); const groups: GroupMap = new Map();
  const moves = cs.map((c) => { const f = findClip(e.seq, c.id); assertUnlocked(f.track, 'move source'); return f; });
  const plan = moves.map(({ track, clip }) => {
    const list = clip.stream === 'video' ? e.seq.videoTracks : e.seq.audioTracks; const d = m.trackDelta?.[clip.stream] ?? 0;
    const dest = list[list.indexOf(track) + d]; if (!dest) fail('InvalidArgument', `no ${clip.stream} track at offset ${d}`);
    assertUnlocked(dest!, 'move destination'); const start = clip.start + m.deltaFrames;
    if (start < 0) fail('InvalidArgument', 'move would place a clip before time 0', { clipId: clip.id });
    return { clip: plain(clip), dest: dest!, start };
  });
  for (const { track, clip } of moves) track.clips.splice(track.clips.findIndex((c) => c.id === clip.id), 1);
  for (const p of plan) {
    if (m.mode === 'overwrite') clearRange(e, p.dest, p.start, p.start + p.clip.duration, groups);
    else if (p.dest.clips.some((c) => c.start < p.start + p.clip.duration && p.start < endOf(c))) fail('Collision', `moving ${p.clip.id} would overlap another clip on ${p.dest.name}`, { trackId: p.dest.id });
  }
  for (const p of plan) { p.clip.start = p.start; p.dest.clips.push(p.clip); }
  for (const p of plan) { sortClips(p.dest); if (p.dest.clips.some((c, i, a) => i > 0 && c.start < endOf(a[i - 1]!))) fail('Collision', 'moved clips overlap each other'); }
  const lo = Math.min(...plan.map((p) => Math.min(p.start, p.start - m.deltaFrames))), hi = Math.max(...plan.map((p) => Math.max(endOf(p.clip), endOf(p.clip) - m.deltaFrames)));
  e.ctx.touch(e.seq.id, lo, hi);
}

export interface TrimSpec { clipId: Id; edge: 'start' | 'end'; toTime: number; ripple?: boolean; ignoreLinks?: boolean; allowPartial?: boolean }
export function trimClip(e: Edit, s: TrimSpec): void {
  intOk(s.toTime, 'toTime'); const lead = findClip(e.seq, s.clipId).clip;
  const delta = s.toTime - (s.edge === 'start' ? lead.start : endOf(lead));
  if (delta === 0) fail('NothingToDo', 'edge is already at that time');
  const members = expandLinked(e.seq, [s.clipId], s.ignoreLinks).map((c) => findClip(e.seq, c.id));
  for (const m of members) assertUnlocked(m.track, 'trim');
  const old = members.map((m) => ({ start: m.clip.start, end: endOf(m.clip) }));
  members.forEach((m, i) => {
    const c = m.clip; const media = mediaOf(e, c);
    if (s.edge === 'end') {
      const newDur = c.duration + delta; if (newDur < 1) fail('InvalidArgument', 'trim would make the clip shorter than one frame');
      if (!s.ripple && delta > 0) { const nxt = m.track.clips.find((o) => o.start >= old[i]!.end && o !== c); if (nxt && c.start + newDur > nxt.start) fail('Collision', `trim end would overlap ${nxt.id}`, { clipId: nxt.id, limit: nxt.start }); }
      c.duration = newDur;
    } else {
      const newStart = s.ripple ? c.start : c.start + delta; const newDur = c.duration - delta;
      if (newDur < 1) fail('InvalidArgument', 'trim would make the clip shorter than one frame');
      if (newStart < 0) fail('InvalidArgument', 'trim would move the clip before time 0');
      if (!s.ripple && delta < 0) { const prev = [...m.track.clips].reverse().find((o) => endOf(o) <= old[i]!.start && o !== c); if (prev && newStart < endOf(prev)) fail('Collision', `trim start would overlap ${prev.id}`, { clipId: prev.id, limit: endOf(prev) }); }
      // new source-in is where the edge lands in the source: measured with the OLD placement
      const src = sourceAtBoundary(e.seq, media, c, c.start + delta);
      c.sourceIn = src; c.duration = newDur; c.start = newStart;
    }
    if (!clipWithinSource(c, e.seq, media)) fail('InsufficientHandle', `not enough source media to ${delta > 0 ? 'extend' : 'trim'} ${c.name} (${s.edge}); handle exhausted`, { clipId: c.id });
  });
  if (s.ripple) {
    const d = s.edge === 'end' ? delta : -delta; // change in clip length
    const ownTracks = members.map((m) => m.track);
    const at = Math.min(...old.map((o) => o.end));
    const tracks = rippleTracks(e, ownTracks, at);
    if (d > 0) {
      // lengthened: push everything after the old end right (spanning clips on other tracks are split there)
      const groups: GroupMap = new Map();
      for (const t of tracks) { const own = members.find((m) => m.track === t); const pt = own ? old[members.indexOf(own)]!.end : at;
        for (const c of [...t.clips]) if (c.start < pt && endOf(c) > pt && !members.some((m) => m.clip === c)) splitAt(e, t, c, pt, groups);
        for (const c of t.clips) if (c.start >= pt && !members.some((m) => m.clip === c)) c.start += d; }
    } else {
      const b = at, a = at + d; // vacated [a,b)
      for (const t of tracks) { const own = members.find((m) => m.track === t); if (own) { const pt = old[members.indexOf(own)]!.end; for (const c of t.clips) if (c.start >= pt && c !== own.clip) c.start += d; } }
      const others = tracks.filter((t) => !members.some((m) => m.track === t));
      closeGap(e, others, a, b, !!s.allowPartial);
    }
  }
  for (const t of new Set(members.map((m) => m.track))) { sortClips(t); }
  if (s.ripple) normalizeLinks(e);
  e.ctx.touch(e.seq.id, Math.min(...old.map((o) => o.start), s.toTime), Math.max(...old.map((o) => o.end), s.toTime) + 1);
}

export function slipClips(e: Edit, clipId: Id, deltaFrames: number, ignoreLinks?: boolean): void {
  if (!Number.isSafeInteger(deltaFrames) || deltaFrames === 0) fail('InvalidArgument', 'slip needs a non-zero integer frame delta');
  for (const { track, clip } of expandLinked(e.seq, [clipId], ignoreLinks).map((c) => findClip(e.seq, c.id))) {
    assertUnlocked(track, 'slip'); const media = mediaOf(e, clip);
    const shift = Frac.of(deltaFrames).div(rateFrac(e.seq.rate)).mul(Frac.of(clip.speed.num, clip.speed.den));
    clip.sourceIn = normalizeSource(seconds(clip.sourceIn).add(shift), nativeRateOf(media, clip.stream));
    if (!clipWithinSource(clip, e.seq, media)) fail('InsufficientHandle', `not enough source media to slip ${clip.name} by ${deltaFrames}`, { clipId: clip.id });
    e.ctx.touch(e.seq.id, clip.start, endOf(clip));
  }
}

export function linkClips(e: Edit, ids: Id[]): void {
  if (ids.length < 2) fail('InvalidArgument', 'linking needs at least two clips');
  const found = ids.map((id) => findClip(e.seq, id)); const groups = new Set(found.map((f) => f.clip.linkGroupId).filter(Boolean));
  const gid = e.ctx.newId('link');
  for (const t of tracksOf(e.seq)) for (const c of t.clips) if (c.linkGroupId && groups.has(c.linkGroupId)) c.linkGroupId = gid;
  for (const f of found) f.clip.linkGroupId = gid;
  e.ctx.touch(e.seq.id);
}
export function unlinkClips(e: Edit, ids: Id[]): void {
  for (const id of ids) { const { clip } = findClip(e.seq, id); delete clip.linkGroupId; }
  // a group left with a single member is dissolved
  const counts = new Map<Id, Clip[]>(); for (const t of tracksOf(e.seq)) for (const c of t.clips) if (c.linkGroupId) counts.set(c.linkGroupId, [...(counts.get(c.linkGroupId) ?? []), c]);
  for (const cs of counts.values()) if (cs.length === 1) delete cs[0]!.linkGroupId;
  e.ctx.touch(e.seq.id);
}

/** Valid range for an edge during a trim gesture, for UI clamping. Pure (read-only). */
export function trimLimits(seq: Sequence, media: MediaRef, clip: Clip, edge: 'start' | 'end', ripple = false): { min: number; max: number } {
  const track = tracksOf(seq).find((t) => t.clips.some((c) => c.id === clip.id))!;
  const tol = sourceTolerance(media, clip.stream); void tol;
  const total = streamDuration(media, clip.stream)!; const spanPerFrame = sourceSpan(1, clip.speed, seq.rate);
  const lo0 = clip.speed.num >= 0 ? seconds(clip.sourceIn) : seconds(clip.sourceIn).sub(sourceSpan(clip.duration, clip.speed, seq.rate));
  const framesBackward = toSafeInt(lo0.div(spanPerFrame).floor()); // source frames available before the clip
  const framesForward = toSafeInt(total.sub(lo0.add(sourceSpan(clip.duration, clip.speed, seq.rate))).div(spanPerFrame).floor());
  if (edge === 'end') {
    const nxt = ripple ? Infinity : Math.min(Infinity, ...track.clips.filter((c) => c.start >= endOf(clip)).map((c) => c.start));
    return { min: clip.start + 1, max: Math.min(endOf(clip) + Math.max(0, framesForward), nxt) };
  }
  const prev = ripple ? -Infinity : Math.max(0, ...track.clips.filter((c) => endOf(c) <= clip.start).map(endOf));
  return { min: Math.max(prev, ripple ? clip.start - Math.max(0, framesBackward) : clip.start - Math.max(0, framesBackward)), max: endOf(clip) - 1 };
}
