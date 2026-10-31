import { FPS, Rate } from '@fs/timeline-model';
import type { Id, ProjectDoc, Sequence, Track } from './types.ts';

export const makeTrack = (id: Id, kind: 'video' | 'audio', name: string): Track => ({
  id, kind, name, locked: false, muted: false, solo: false, visible: true, syncLock: true, targeted: true, height: 48, clips: [],
});

export interface SequenceInit { id: Id; name: string; rate?: Rate; width?: number; height?: number; sampleRate?: number; dropFrame?: boolean; videoTracks?: number; audioTracks?: number }
export function makeSequence(i: SequenceInit): Sequence {
  const vt = i.videoTracks ?? 2, at = i.audioTracks ?? 2;
  return {
    id: i.id, name: i.name, rate: i.rate ?? FPS.f25, width: i.width ?? 1920, height: i.height ?? 1080, par: { num: 1, den: 1 },
    sampleRate: i.sampleRate ?? 48000, dropFrame: i.dropFrame ?? false, startFrame: 0,
    videoTracks: Array.from({ length: vt }, (_, n) => makeTrack(`${i.id}_V${n + 1}`, 'video', `V${n + 1}`)),
    audioTracks: Array.from({ length: at }, (_, n) => makeTrack(`${i.id}_A${n + 1}`, 'audio', `A${n + 1}`)),
    markers: [], inPoint: null, outPoint: null,
  };
}

export function makeProject(id: Id, name: string, createdAt: string): ProjectDoc {
  return { id, name, createdAt, mediaPool: {}, mediaOrder: [], bins: {}, binOrder: [], sequences: {}, sequenceOrder: [], activeSequenceId: null, exportPresets: [], extensions: {} };
}
