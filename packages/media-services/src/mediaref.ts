import { time, rate } from '@fs/timeline-model';
import type { MediaRef } from '@fs/project-model';
import { makePathRef } from '@fs/project-model';
import type { ProbeResult } from '@fs/media-contracts';
import * as path from 'node:path';

/** Convert a probe result into the persistent MediaRef. Audio duration is rounded DOWN so clips never reference past real samples. */
export function toMediaRef(p: ProbeResult, id: string, projectDir: string, binId: string | null = null): MediaRef {
  const m: MediaRef = { id, name: path.basename(p.path), binId, path: makePathRef(projectDir, p.path), fingerprint: p.fingerprint, container: p.container, metadata: {} };
  if (p.startTimecode) m.startTimecode = p.startTimecode;
  if (p.video) m.video = { codec: p.video.codec, width: p.video.width, height: p.video.height, rate: p.video.rate, duration: time(p.video.frameCount, p.video.rate), rotation: p.video.rotation, par: p.video.par, pixFmt: p.video.pixFmt, bitDepth: p.video.bitDepth, vfr: p.video.vfr,
    colour: { primaries: p.video.primaries, transfer: p.video.transfer, matrix: p.video.matrix, range: p.video.range } };
  if (p.audio) m.audio = { codec: p.audio.codec, sampleRate: p.audio.sampleRate, channels: p.audio.channels, layout: p.audio.layout, duration: time(Math.floor(p.audio.durationSec * p.audio.sampleRate), rate(p.audio.sampleRate)) };
  // drop undefined keys so the saved JSON is canonical
  return JSON.parse(JSON.stringify(m));
}
