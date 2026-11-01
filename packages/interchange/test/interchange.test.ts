import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs'; import * as os from 'node:os'; import * as path from 'node:path';
import { FPS, time, rate } from '@fs/timeline-model';
import { makeProject, makeSequence } from '@fs/project-model';
import { CommandEngine } from '@fs/command-engine';
import { exportOtio, exportEdl, parseEdl, lossText } from '../src/index.ts';

const media = (id: string, frames: number, fr = FPS.f25) => ({ id, name: `${id}.mp4`, binId: null, path: { absolute: `/media/${id}.mp4` }, fingerprint: { size: 1, headHash: 'a', tailHash: 'b' }, metadata: {},
  video: { codec: 'h264', width: 640, height: 360, rate: fr, duration: time(frames, fr), rotation: 0, par: { num: 1, den: 1 }, colour: {} }, audio: { codec: 'aac', sampleRate: 48000, channels: 2, duration: time(Math.floor(frames * fr.den * 48000 / fr.num), rate(48000)) } });
function project(seqRate = FPS.f25, dropFrame = false) {
  let n = 0; const e = new CommandEngine(makeProject('p', 'P', 'x'), { idSource: () => `t${++n}` });
  e.execute({ type: 'media.add', media: media('A', 250) as never }); e.execute({ type: 'media.add', media: media('B', 100) as never });
  e.execute({ type: 'sequence.create', sequence: { ...makeSequence({ id: 's', name: 'Seq', rate: seqRate }), dropFrame } });
  e.execute({ type: 'edit.insert', sequenceId: 's', mediaId: 'A', time: 0, sourceIn: time(50, FPS.f25), sourceOut: time(150, FPS.f25) });
  e.execute({ type: 'edit.overwrite', sequenceId: 's', mediaId: 'B', time: 130, sourceIn: time(0, FPS.f25), sourceOut: time(40, FPS.f25) });  // gap 100..130
  e.execute({ type: 'marker.add', sequenceId: 's', marker: { time: 20, duration: 0, name: 'beat', color: 'red', comment: 'c' } });
  e.execute({ type: 'edit.split', sequenceId: 's', time: 60, allTracks: true });
  return e.state;
}
const py = (code: string, ...args: string[]) => spawnSync('python3', ['-I', '-c', code, ...args], { encoding: 'utf8' });
const haveOtio = py('import opentimelineio').status === 0;

describe('OTIO export', () => {
  it('structure, gaps, rational ranges, markers and an explicit loss report', () => {
    const { json, loss } = exportOtio(project(), 's'); const t = JSON.parse(json);
    const v1 = t.tracks.children.find((x: any) => x.name === 'V1'); expect(v1.children.map((c: any) => c.OTIO_SCHEMA)).toEqual(['Clip.2', 'Clip.2', 'Gap.1', 'Clip.2']);
    expect(v1.children[0].source_range.start_time).toEqual({ OTIO_SCHEMA: 'RationalTime.1', rate: 25, value: 50 }); expect(t.tracks.markers).toHaveLength(1);
    expect(lossText(loss)).toMatch(/linked A\/V clips/); expect(loss.items.every((i) => i.severity)).toBe(true);
  });
  it.skipIf(!haveOtio)('is read by an INDEPENDENT implementation (opentimelineio 0.18) with identical timing', () => {
    const doc = project(); const { json } = exportOtio(doc, 's'); const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'otio-')), 't.otio'); fs.writeFileSync(f, json);
    const r = py(`import sys, json, opentimelineio as o
t=o.adapters.read_from_file(sys.argv[1]); out={}
for tr in t.video_tracks()+t.audio_tracks():
    out[tr.name]=[[type(c).__name__, round(c.source_range.start_time.to_seconds(),6), round(c.source_range.duration.to_seconds(),6), round(tr.range_of_child(c).start_time.to_seconds(),6)] for c in tr]
print(json.dumps({'tracks':out,'markers':len(t.tracks.markers),'dur':round(t.duration().to_seconds(),6)}))`, f);
    expect(r.status, r.stderr).toBe(0); const got = JSON.parse(r.stdout); const s = doc.sequences.s!;
    const sec = (ticks: number, r: { num: number; den: number }) => Math.round((ticks * r.den / r.num) * 1e6) / 1e6; const fr = (n: number) => sec(n, { num: 25, den: 1 });
    const want = (tracks: typeof s.videoTracks) => Object.fromEntries(tracks.map((t) => { const out: unknown[] = []; let at = 0; for (const c of t.clips) { if (c.start > at) out.push(['Gap', 0, fr(c.start - at), fr(at)]); out.push(['Clip', sec(c.sourceIn.ticks, c.sourceIn.rate), fr(c.duration), fr(c.start)]); at = c.start + c.duration; } return [t.name, out]; }));
    expect(got.tracks).toEqual({ ...want(s.videoTracks), ...want(s.audioTracks) }); expect(got.markers).toBe(1); expect(got.dur).toBe(fr(Math.max(...[...s.videoTracks, ...s.audioTracks].flatMap((t) => t.clips.map((c) => c.start + c.duration)))));
  });
});

describe('EDL export/import', () => {
  it('round-trips record/source timecodes through our parser', () => {
    const doc = project(); const { edl } = exportEdl(doc, 's'); const p = parseEdl(edl, FPS.f25); const clips = doc.sequences.s!.videoTracks[0]!.clips;
    const v = p.events.filter((e) => e.kind === 'V'); expect(v).toHaveLength(clips.length);
    clips.forEach((c, i) => { expect([v[i]!.recIn, v[i]!.recOut, v[i]!.srcIn]).toEqual([c.start, c.start + c.duration, c.sourceIn.ticks]); expect(v[i]!.clipName).toMatch(/\.mp4$/); });
  });
  it('drop-frame header and numbering at 29.97', () => {
    const doc = project(FPS.f29_97, true); const { edl } = exportEdl(doc, 's'); expect(edl).toMatch(/FCM: DROP FRAME/); expect(edl).toMatch(/\d\d:\d\d:\d\d;\d\d/);
    const p = parseEdl(edl, FPS.f29_97); expect(p.dropFrame).toBe(true); expect(p.events.length).toBeGreaterThan(0);
  });
  it.skipIf(!haveOtio)('is read by an INDEPENDENT implementation (OTIO cmx_3600 adapter) with the same record times', () => {
    const doc = project(); const { edl } = exportEdl(doc, 's'); const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'edl-')), 't.edl'); fs.writeFileSync(f, edl);
    const r = py(`import sys, json, opentimelineio as o
t=o.adapters.read_from_file(sys.argv[1], adapter_name='cmx_3600', rate=25)
print(json.dumps([[tr.kind, [[c.name, c.source_range.start_time.value, c.source_range.duration.value] for c in tr if isinstance(c,o.schema.Clip)]] for tr in t.tracks]))`, f);
    expect(r.status, r.stderr).toBe(0); const got = JSON.parse(r.stdout); const clips = doc.sequences.s!.videoTracks[0]!.clips;
    const video = got.find((x: any) => x[0] === 'Video')[1]; expect(video.map((c: any) => [c[1], c[2]])).toEqual(clips.map((c) => [c.sourceIn.ticks, c.duration]));
  });
  it('unsupported edit types are reported by the importer, not dropped silently', () => {
    const p = parseEdl('001  AX  V  D  001  00:00:00:00 00:00:01:00 00:00:00:00 00:00:01:00', FPS.f25); expect(p.events).toEqual([]); expect(p.warnings.join()).toMatch(/not supported|ignored line/);
    void execFileSync;
  });
});
