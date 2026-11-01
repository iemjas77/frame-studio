import { Frac, Rate, seconds } from '@fs/timeline-model';
import type { Clip, ProjectDoc, Sequence, Track } from '@fs/project-model';
import type { LossItem, LossReport } from './loss.ts';

const rt = (value: number, r: Rate) => ({ OTIO_SCHEMA: 'RationalTime.1', rate: r.num / r.den, value });
const tr = (start: number, dur: number, r: Rate) => ({ OTIO_SCHEMA: 'TimeRange.1', start_time: rt(start, r), duration: rt(dur, r) });

/**
 * Export a sequence as OpenTimelineIO JSON (Timeline.1 / Stack.1 / Track.1 / Clip.2 / Gap.1).
 * Rational timing: sequence positions are RationalTime at the sequence rate; source start is expressed in the clip's own
 * source domain (media frames / samples / exact rational ticks) so no rounding is introduced by the exporter.
 */
export function exportOtio(doc: ProjectDoc, sequenceId: string): { json: string; loss: LossReport } {
  const seq: Sequence | undefined = doc.sequences[sequenceId]; if (!seq) throw new Error(`sequence ${sequenceId} not found`);
  const loss: LossItem[] = [];
  const mkTrack = (t: Track): object => {
    const children: object[] = []; let at = 0;
    for (const c of t.clips) {
      if (c.start > at) children.push({ OTIO_SCHEMA: 'Gap.1', name: '', source_range: tr(0, c.start - at, seq.rate), effects: [], markers: [], metadata: {} });
      const m = doc.mediaPool[c.mediaId]!; const srcRate: Rate = c.sourceIn.rate;
      if (c.speed.num !== 1 || c.speed.den !== 1) loss.push({ feature: 'speed', detail: `clip ${c.name} speed ${c.speed.num}/${c.speed.den} not written as LinearTimeWarp`, severity: 'lost' });
      children.push({ OTIO_SCHEMA: 'Clip.2', name: c.name, enabled: c.enabled, source_range: { OTIO_SCHEMA: 'TimeRange.1', start_time: rt(c.sourceIn.ticks, srcRate), duration: rt(c.duration * srcRate.num * seq.rate.den / (srcRate.den * seq.rate.num), srcRate) },
        media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: 'ExternalReference.1', name: m.name, target_url: m.path.absolute, available_range: null, metadata: { frame_studio: { fingerprint: m.fingerprint } } } }, active_media_reference_key: 'DEFAULT_MEDIA',
        effects: [], markers: [], metadata: { frame_studio: { clipId: c.id, linkGroupId: c.linkGroupId ?? null, stream: c.stream, sequenceDurationFrames: c.duration, gain: c.gain ?? 1 } } });
      at = c.start + c.duration;
    }
    return { OTIO_SCHEMA: 'Track.1', name: t.name, kind: t.kind === 'video' ? 'Video' : 'Audio', children, source_range: null, effects: [], markers: [], enabled: t.visible && !t.muted, metadata: { frame_studio: { locked: t.locked, syncLock: t.syncLock, solo: t.solo, muted: t.muted, visible: t.visible } } };
  };
  if ([...seq.videoTracks, ...seq.audioTracks].some((t) => t.locked || t.syncLock || t.solo)) loss.push({ feature: 'track lock / sync lock / solo', detail: 'no OTIO equivalent; kept under metadata.frame_studio and ignored by other tools', severity: 'preserved-as-metadata' });
  if ([...seq.videoTracks, ...seq.audioTracks].some((t) => t.clips.some((c) => c.linkGroupId))) loss.push({ feature: 'linked A/V clips', detail: 'OTIO has no link groups; group id kept under metadata.frame_studio.linkGroupId', severity: 'preserved-as-metadata' });
  if (seq.dropFrame) loss.push({ feature: 'drop-frame display', detail: 'OTIO RationalTime has no drop-frame flag; numbering is not carried', severity: 'lost' });
  if (seq.startFrame) loss.push({ feature: 'timecode offset', detail: `sequence start frame ${seq.startFrame} written as global_start_time`, severity: 'preserved-as-metadata' });
  const stack = { OTIO_SCHEMA: 'Stack.1', name: 'tracks', children: [...seq.videoTracks, ...seq.audioTracks].map(mkTrack), source_range: null, effects: [], markers: [], enabled: true, metadata: {} };
  const markers = seq.markers.map((k) => ({ OTIO_SCHEMA: 'Marker.2', name: k.name, color: k.color.toUpperCase(), marked_range: tr(k.time, Math.max(0, k.duration), seq.rate), comment: k.comment, metadata: {} }));
  stack.markers = markers as never;
  const tl = { OTIO_SCHEMA: 'Timeline.1', name: seq.name, global_start_time: seq.startFrame ? rt(seq.startFrame, seq.rate) : null, tracks: stack, metadata: { frame_studio: { width: seq.width, height: seq.height, sampleRate: seq.sampleRate } } };
  loss.push({ feature: 'effects / transitions / titles', detail: 'none exist in project schema v1, so nothing is dropped', severity: 'preserved-as-metadata' });
  return { json: JSON.stringify(tl, null, 2), loss: { format: 'OpenTimelineIO JSON', items: loss } };
}
void Frac; void seconds;
