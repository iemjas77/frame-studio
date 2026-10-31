import type { Rate, Speed, Time } from '@fs/timeline-model';

export type Id = string;
export const FORMAT_NAME = 'frame-studio-project';
export const SCHEMA_VERSION = 1;

export interface PathRef { /** as last resolved on the authoring machine */ absolute: string; /** relative to the project file's folder when possible */ relative?: string }
export interface Fingerprint { size: number; /** sha256 hex of first min(size,1MiB) bytes */ headHash: string; /** sha256 hex of last min(size,1MiB) bytes */ tailHash: string }
export interface ColourTags { primaries?: string; transfer?: string; matrix?: string; range?: 'limited' | 'full' }
export interface VideoInfo {
  codec: string; width: number; height: number; rate: Rate; /** duration in frames of `rate` */ duration: Time;
  rotation: number; par: { num: number; den: number }; pixFmt?: string; colour: ColourTags; vfr?: boolean; bitDepth?: number;
}
export interface AudioInfo { codec: string; sampleRate: number; channels: number; layout?: string; /** duration in samples */ duration: Time }
export interface Interpretation { frameRate?: Rate; par?: { num: number; den: number }; colour?: ColourTags }
export interface ProxyRef { path: PathRef; fingerprint?: Fingerprint; width: number; height: number; enabled: boolean }
export interface MediaRef {
  id: Id; name: string; binId: Id | null; path: PathRef; fingerprint: Fingerprint;
  container?: string; video?: VideoInfo; audio?: AudioInfo;
  /** timecode of the first frame as embedded in the file, if any */ startTimecode?: string;
  interpretation?: Interpretation; proxy?: ProxyRef; metadata: Record<string, string>;
}
export interface Bin { id: Id; name: string; parentId: Id | null }

export interface Marker { id: Id; time: number; duration: number; name: string; color: string; comment: string }
export interface Clip {
  id: Id; name: string; mediaId: Id; /** which stream of the media this clip presents */ stream: 'video' | 'audio';
  /** sequence frames, half-open [start, start+duration) */ start: number; duration: number;
  /** position in media domain (video: frames; audio: samples) at clip start */ sourceIn: Time; speed: Speed;
  linkGroupId?: Id; enabled: boolean; /** linear gain, audio clips */ gain?: number;
}
export interface Track {
  id: Id; kind: 'video' | 'audio'; name: string; locked: boolean; muted: boolean; solo: boolean; visible: boolean;
  syncLock: boolean; targeted: boolean; height: number; clips: Clip[];
}
export interface Sequence {
  id: Id; name: string; rate: Rate; width: number; height: number; par: { num: number; den: number };
  sampleRate: number; dropFrame: boolean; /** frame number displayed as 00:00:00:00 offset (timecode start) */ startFrame: number;
  videoTracks: Track[]; audioTracks: Track[]; markers: Marker[];
  inPoint: number | null; outPoint: number | null;
}
export interface ExportPreset { id: Id; name: string; container: 'mp4' | 'mov' | 'mkv'; videoCodec: string; audioCodec: string; crf?: number; videoBitrate?: number; audioBitrate?: number; width?: number; height?: number }
export interface ProjectDoc {
  id: Id; name: string; createdAt: string;
  mediaPool: Record<Id, MediaRef>; mediaOrder: Id[];
  bins: Record<Id, Bin>; binOrder: Id[];
  sequences: Record<Id, Sequence>; sequenceOrder: Id[]; activeSequenceId: Id | null;
  exportPresets: ExportPreset[];
  /** reserved for forward-compatible data written by newer/other tools; preserved verbatim */
  extensions: Record<string, unknown>;
  [unknown: string]: unknown;
}
export interface Envelope {
  format: typeof FORMAT_NAME; schemaVersion: number; appVersion: string; savedAt: string;
  checksum: { algo: 'sha256'; value: string }; project: ProjectDoc;
}
