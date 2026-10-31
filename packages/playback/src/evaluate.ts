/**
 * The single semantic evaluator for "what is on screen / in the mix". Preview, scrubbing and export all derive from
 * these functions so they cannot disagree about timeline meaning. Pure; reads an immutable project snapshot.
 */
import { Frac, Rate, rateFrac, sourceSampleAtBoundary, sourceVideoFrameAt } from '@fs/timeline-model';
import type { Clip, ProjectDoc, Sequence, Track } from '@fs/project-model';

export interface ActiveClip { track: Track; clip: Clip; trackIndex: number }
const end = (c: Clip) => c.start + c.duration;

/** Video clips that can contribute, bottom track first. Hidden tracks and disabled clips are excluded. */
export function activeVideoClips(seq: Sequence): ActiveClip[] {
  return seq.videoTracks.flatMap((track, trackIndex) => (track.visible ? track.clips.filter((c) => c.enabled).map((clip) => ({ track, clip, trackIndex })) : []));
}
/** Audio clips in the mix: muted tracks excluded; if any track is soloed only soloed tracks play. */
export function activeAudioClips(seq: Sequence): ActiveClip[] {
  const solo = seq.audioTracks.some((t) => t.solo);
  return seq.audioTracks.flatMap((track, trackIndex) => (!track.muted && (!solo || track.solo) ? track.clips.filter((c) => c.enabled).map((clip) => ({ track, clip, trackIndex })) : []));
}
export const sequenceEnd = (seq: Sequence): number => Math.max(0, ...[...seq.videoTracks, ...seq.audioTracks].flatMap((t) => t.clips.map(end)));

export interface VideoLayer { trackId: string; trackIndex: number; clipId: string; mediaId: string; /** frame index in the media's own frame domain */ sourceFrame: number; mediaRate: Rate }
/** Layers visible at sequence frame k, TOP first. Gaps -> []. (Compositing beyond "topmost opaque" is Planned for M4.) */
export function videoLayersAt(doc: ProjectDoc, seq: Sequence, k: number): VideoLayer[] {
  const out: VideoLayer[] = [];
  for (const { track, clip, trackIndex } of activeVideoClips(seq)) {
    if (k < clip.start || k >= end(clip)) continue;
    const m = doc.mediaPool[clip.mediaId]; if (!m?.video) continue;
    const sourceFrame = sourceVideoFrameAt({ start: clip.start, sourceIn: clip.sourceIn, speed: clip.speed, seqRate: seq.rate }, k, m.video.rate);
    out.push({ trackId: track.id, trackIndex, clipId: clip.id, mediaId: clip.mediaId, sourceFrame, mediaRate: m.video.rate });
  }
  return out.sort((a, b) => b.trackIndex - a.trackIndex);
}

export interface AudioSegment { trackId: string; clipId: string; mediaId: string; /** output sample offset where the segment starts */ outStartSample: number; sampleCount: number; sourceStartSample: number; sourceRate: number; gain: number }
/** Audio segments in OUTPUT sample time (sequence sample rate). Boundaries are computed independently from exact frame boundaries, so segments tile with no drift or gaps. */
export function audioSegments(doc: ProjectDoc, seq: Sequence, range?: { start: number; end: number }): AudioSegment[] {
  const sr = seq.sampleRate; const r0 = range?.start ?? 0; const out: AudioSegment[] = [];
  const toOut = (frame: number) => Number(Frac.of(frame).div(rateFrac(seq.rate)).mul(Frac.of(sr)).round('nearest'));
  for (const { track, clip } of activeAudioClips(seq)) {
    const a = Math.max(clip.start, r0), b = Math.min(end(clip), range?.end ?? Infinity); if (b <= a) continue;
    const m = doc.mediaPool[clip.mediaId]; if (!m?.audio) continue;
    const p = { start: clip.start, sourceIn: clip.sourceIn, speed: clip.speed, seqRate: seq.rate };
    const s0 = toOut(a) - toOut(r0), s1 = toOut(b) - toOut(r0);
    out.push({ trackId: track.id, clipId: clip.id, mediaId: clip.mediaId, outStartSample: s0, sampleCount: s1 - s0, sourceStartSample: sourceSampleAtBoundary(p, a, { num: m.audio.sampleRate, den: 1 }), sourceRate: m.audio.sampleRate, gain: clip.gain ?? 1 });
  }
  return out;
}
