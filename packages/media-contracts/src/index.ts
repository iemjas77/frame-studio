/** Stable, versioned contracts between the editor/host and media services. Frames are NEVER carried in JSON. */
import type { Rate } from '@fs/timeline-model';

export const MEDIA_CONTRACT_VERSION = 1;

export interface ProbedVideo { codec: string; profile?: string; width: number; height: number; rate: Rate; frameCount: number; durationSec: number; rotation: number; par: { num: number; den: number }; pixFmt?: string; bitDepth?: number; primaries?: string; transfer?: string; matrix?: string; range?: 'limited' | 'full'; vfr: boolean; hasBFrames: boolean; startSec: number }
export interface ProbedAudio { codec: string; sampleRate: number; channels: number; layout?: string; durationSec: number; sampleCount: number; startSec: number }
export interface ProbeResult {
  path: string; size: number; container: string; durationSec: number; startTimecode?: string;
  video?: ProbedVideo; audio?: ProbedAudio; streamCounts: { video: number; audio: number; other: number };
  fingerprint: { size: number; headHash: string; tailHash: string }; warnings: string[];
}
export type ProbeErrorCode = 'NotFound' | 'NotAFile' | 'Empty' | 'Timeout' | 'TooMuchOutput' | 'Unreadable' | 'NoStreams' | 'ToolMissing';
export class MediaError extends Error { constructor(readonly code: ProbeErrorCode, message: string) { super(message); this.name = 'MediaError'; } }

export interface ProbeLimits { timeoutMs: number; maxOutputBytes: number; maxFileBytes: number }
export const DEFAULT_PROBE_LIMITS: ProbeLimits = { timeoutMs: 15_000, maxOutputBytes: 4 * 1024 * 1024, maxFileBytes: 512 * 1024 ** 3 };

export type ExportPhase = 'preparing' | 'encoding' | 'validating' | 'finalizing' | 'done' | 'failed' | 'cancelled';
export interface ExportProgress { phase: ExportPhase; frame: number; totalFrames: number; fraction: number; message?: string }
export interface ExportCheck { name: string; ok: boolean; detail: string }
export interface ExportReport { ok: boolean; output?: string; checks: ExportCheck[]; warnings: string[]; ffmpegCommand?: string[] }
