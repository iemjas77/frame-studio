import { Frac, seconds } from '@fs/timeline-model';
import type { MediaRef } from '@fs/project-model';
import type { ProbeResult } from '@fs/media-contracts';

export interface IdentityVerdict { verdict: 'identical' | 'likely' | 'mismatch'; reasons: string[] }

/**
 * Relinking never trusts a file name. A candidate is judged on content:
 *  identical = same size + head/tail hashes (byte-for-byte same start and end);
 *  likely    = same streams, dimensions, frame rate, sample rate and duration within one frame, different bytes (e.g. re-wrapped); needs explicit user confirmation;
 *  mismatch  = anything that would change timing or picture; refused.
 */
export function assessIdentity(ref: MediaRef, cand: ProbeResult): IdentityVerdict {
  const fp = ref.fingerprint; const reasons: string[] = [];
  if (cand.fingerprint.size === fp.size && cand.fingerprint.headHash === fp.headHash && cand.fingerprint.tailHash === fp.tailHash) return { verdict: 'identical', reasons: ['size and head/tail hashes match'] };
  const bad = (m: string) => reasons.push(m);
  if (!!ref.video !== !!cand.video) bad(`video stream ${ref.video ? 'missing in' : 'unexpected in'} candidate`);
  if (!!ref.audio !== !!cand.audio) bad(`audio stream ${ref.audio ? 'missing in' : 'unexpected in'} candidate`);
  if (ref.video && cand.video) {
    if (ref.video.width !== cand.video.width || ref.video.height !== cand.video.height) bad(`dimensions differ (${ref.video.width}x${ref.video.height} vs ${cand.video.width}x${cand.video.height})`);
    if (ref.video.rate.num * cand.video.rate.den !== cand.video.rate.num * ref.video.rate.den) bad(`frame rate differs (${ref.video.rate.num}/${ref.video.rate.den} vs ${cand.video.rate.num}/${cand.video.rate.den})`);
    const frameSec = Frac.of(ref.video.rate.den, ref.video.rate.num); const d = seconds(ref.video.duration).sub(Frac.of(Math.round(cand.video.durationSec * 1e6), 1e6)); const ad = d.n < 0n ? d.neg() : d;
    if (ad.cmp(frameSec) > 0) bad(`video duration differs by ${ad.toNumber().toFixed(3)} s`);
  }
  if (ref.audio && cand.audio) {
    if (ref.audio.sampleRate !== cand.audio.sampleRate) bad(`sample rate differs (${ref.audio.sampleRate} vs ${cand.audio.sampleRate})`);
    const dd = Math.abs(ref.audio.duration.ticks / ref.audio.sampleRate - cand.audio.durationSec); if (dd > 0.05) bad(`audio duration differs by ${dd.toFixed(3)} s`);
  }
  if (reasons.length) return { verdict: 'mismatch', reasons };
  return { verdict: 'likely', reasons: ['streams, dimensions, rates and duration agree, but file bytes differ; confirm this is the same footage'] };
}
