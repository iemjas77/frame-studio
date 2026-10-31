import { Frac, Rate, rateFrac } from '@fs/timeline-model';
import type { MediaRef, ProjectDoc, Sequence } from '@fs/project-model';
import { activeAudioClips, activeVideoClips, audioSegments, sequenceEnd, type AudioSegment } from '@fs/playback';
import { seekSeconds } from '@fs/media-services';
import { sourceVideoFrameAt } from '@fs/timeline-model';

export class ExportError extends Error {
  constructor(readonly code: 'Unsupported' | 'MissingMedia' | 'DestinationExists' | 'DestinationInvalid' | 'EmptyRange' | 'EncoderFailed' | 'ValidationFailed' | 'Cancelled' | 'MediaChanged', message: string, readonly details?: unknown) { super(message); this.name = 'ExportError'; }
}
export interface ExportPreset { container: 'mp4' | 'mov' | 'mkv'; crf: number; audioBitrateK: number; x264Preset: string }
export const PRESET_H264_MP4: ExportPreset = { container: 'mp4', crf: 18, audioBitrateK: 192, x264Preset: 'veryfast' };
export interface PlannedVideoClip { clipId: string; mediaId: string; trackIndex: number; outStart: number; frames: number; seekSec: string; sourceFrame: number }
export interface ExportPlan { seq: Sequence; start: number; end: number; frames: number; width: number; height: number; rate: Rate; sampleRate: number; totalSamples: number; video: PlannedVideoClip[]; audio: AudioSegment[]; warnings: string[]; mediaIds: string[] }

/** Resolve [in,out) = explicit range, else sequence in/out points, else whole sequence. */
export function planExport(doc: ProjectDoc, seqId: string, range?: { start: number; end: number }): ExportPlan {
  const seq = doc.sequences[seqId]; if (!seq) throw new ExportError('EmptyRange', `sequence ${seqId} not found`);
  const start = range?.start ?? seq.inPoint ?? 0; const end = range?.end ?? seq.outPoint ?? sequenceEnd(seq);
  if (!(end > start)) throw new ExportError('EmptyRange', 'nothing to export: the sequence (or selected range) is empty');
  const warnings: string[] = []; const video: PlannedVideoClip[] = []; const mediaIds = new Set<string>();
  for (const { clip, trackIndex } of activeVideoClips(seq)) {
    if (clip.speed.num !== 1 || clip.speed.den !== 1) throw new ExportError('Unsupported', `clip ${clip.name} has a speed change; speed/reverse export is not implemented (Planned M7)`);
    const a = Math.max(clip.start, start), b = Math.min(clip.start + clip.duration, end); if (b <= a) continue;
    const m: MediaRef | undefined = doc.mediaPool[clip.mediaId]; if (!m?.video) continue;
    const sourceFrame = sourceVideoFrameAt({ start: clip.start, sourceIn: clip.sourceIn, speed: clip.speed, seqRate: seq.rate }, a, m.video.rate);
    if (m.video.vfr) warnings.push(`${m.name}: variable frame rate source treated as constant at its nominal rate`);
    if (m.video.rate.num * seq.rate.den !== seq.rate.num * m.video.rate.den) warnings.push(`${m.name}: source rate differs from sequence rate; frames are repeated/dropped by the fps filter (not guaranteed identical to preview mapping)`);
    video.push({ clipId: clip.id, mediaId: clip.mediaId, trackIndex, outStart: a - start, frames: b - a, seekSec: seekSeconds(sourceFrame, m.video.rate), sourceFrame }); mediaIds.add(clip.mediaId);
  }
  for (const { clip } of activeAudioClips(seq)) if (clip.speed.num !== 1 || clip.speed.den !== 1) throw new ExportError('Unsupported', `audio clip ${clip.name} has a speed change; not implemented`);
  const audio = audioSegments(doc, seq, { start, end }); audio.forEach((s) => mediaIds.add(s.mediaId));
  const frames = end - start; const totalSamples = Number(Frac.of(frames).div(rateFrac(seq.rate)).mul(Frac.of(seq.sampleRate)).round('nearest'));
  if (!video.length && !audio.length) throw new ExportError('EmptyRange', 'no clips in the export range');
  return { seq, start, end, frames, width: seq.width, height: seq.height, rate: seq.rate, sampleRate: seq.sampleRate, totalSamples, video, audio, warnings, mediaIds: [...mediaIds] };
}

const sec = (samples: number, sr: number) => (samples / sr).toFixed(9);
/** Build ffmpeg args (array; never a shell string). `paths` maps mediaId -> resolved absolute file. */
export function buildFfmpegArgs(plan: ExportPlan, paths: Record<string, string>, preset: ExportPreset, outFile: string): string[] {
  const args: string[] = ['-v', 'error', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats']; const R = `${plan.rate.num}/${plan.rate.den}`;
  const f: string[] = []; let n = 0;
  const maxTrack = plan.video.length ? Math.max(...plan.video.map((v) => v.trackIndex)) : -1; void maxTrack;
  f.push(`color=c=black:s=${plan.width}x${plan.height}:r=${R}[base0]`);
  let cur = 'base0'; let k = 0;
  for (const v of [...plan.video].sort((a, b) => a.trackIndex - b.trackIndex || a.outStart - b.outStart)) {
    args.push('-ss', v.seekSec, '-i', paths[v.mediaId]!); const i = n++;
    f.push(`[${i}:v]scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${R},trim=end_frame=${v.frames},setpts=round((N+${v.outStart})*${plan.rate.den}/${plan.rate.num}/TB)[v${k}]`);
    f.push(`[${cur}][v${k}]overlay=eof_action=pass:repeatlast=0:format=auto[b${k + 1}]`); cur = `b${k + 1}`; k++;
  }
  f.push(`[${cur}]format=yuv420p[vout]`);
  const labels: string[] = [];
  plan.audio.forEach((s, j) => {
    args.push('-ss', sec(s.sourceStartSample, s.sourceRate), '-i', paths[s.mediaId]!); const i = n++;
    const g = s.gain !== 1 ? `,volume=${s.gain}` : '';
    f.push(`[${i}:a]aresample=${plan.sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end_sample=${s.sampleCount},asetpts=round(N/SR/TB)${g},adelay=${s.outStartSample}S|${s.outStartSample}S[a${j}]`);
    labels.push(`[a${j}]`);
  });
  if (labels.length) f.push(`${labels.join('')}${labels.length > 1 ? `amix=inputs=${labels.length}:normalize=0:duration=longest,` : ''}apad=whole_len=${plan.totalSamples},atrim=end_sample=${plan.totalSamples},asetpts=round(N/SR/TB)[aout]`);
  else f.push(`anullsrc=r=${plan.sampleRate}:cl=stereo,atrim=end_sample=${plan.totalSamples},asetpts=round(N/SR/TB)[aout]`);
  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]', '-frames:v', String(plan.frames), '-fps_mode', 'passthrough',
    '-c:v', 'libx264', '-preset', preset.x264Preset, '-crf', String(preset.crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', `${preset.audioBitrateK}k`, '-ar', String(plan.sampleRate), '-ac', '2');
  if (preset.container === 'mp4' || preset.container === 'mov') args.push('-movflags', '+faststart');
  args.push('-f', preset.container === 'mkv' ? 'matroska' : preset.container === 'mov' ? 'mov' : 'mp4', outFile);
  return args;
}
