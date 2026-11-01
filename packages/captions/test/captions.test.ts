import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FPS } from '@fs/timeline-model';
import { parseSrt, parseVtt, serializeSrt, serializeVtt, validateCues, cuesToFrames, framesToMs, msToFrames, splitCue, mergeCues, trimCue, type Cue } from '../src/index.ts';

const cue = (id: string, a: number, b: number, text = 'hi'): Cue => ({ id, startMs: a, endMs: b, text });
describe('captions', () => {
  it('parses SRT with BOM, CRLF, missing ids, multi-line and Unicode/RTL text', () => {
    const r = parseSrt('﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHéllo 世界\r\nשלום\r\n\r\n00:00:03,000 --> 00:00:04,000\r\nno id\r\n\r\ngarbage block\r\n');
    expect(r.cues).toEqual([cue('1', 1000, 2500, 'Héllo 世界\nשלום'), cue('2', 3000, 4000, 'no id')]); expect(r.warnings).toHaveLength(1);
  });
  it('WebVTT: header required, NOTE/STYLE handled, cue settings kept', () => {
    expect(() => parseVtt('00:00:01.000 --> 00:00:02.000\nx')).toThrow(/WEBVTT/);
    const r = parseVtt('WEBVTT\n\nNOTE hidden\n\nSTYLE\n::cue{}\n\nintro\n00:01.000 --> 00:02.000 align:start\nHi\n');
    expect(r.cues).toEqual([{ id: 'intro', startMs: 1000, endMs: 2000, text: 'Hi', settings: 'align:start' }]); expect(r.warnings.join()).toMatch(/STYLE/);
  });
  it('round-trips arbitrary cues through SRT and VTT', () => {
    const arb = fc.array(fc.record({ gap: fc.integer({ min: 0, max: 5000 }), len: fc.integer({ min: 1, max: 9000 }), text: fc.array(fc.stringMatching(/^[A-Za-z0-9 éß世界!?.,-]{1,20}$/).filter((s) => s.trim().length > 0 && s === s.trim()), { minLength: 1, maxLength: 3 }).map((l) => l.join('\n')) }), { minLength: 1, maxLength: 12 });
    fc.assert(fc.property(arb, (rows) => { let t = 0; const cues = rows.map((r, i) => { t += r.gap; const c = cue(String(i + 1), t, t + r.len, r.text); t += r.len; return c; });
      expect(parseSrt(serializeSrt(cues)).cues).toEqual(cues); expect(parseVtt(serializeVtt(cues)).cues).toEqual(cues); }));
  });
  it('validates overlap, duration, empty text, width and reading speed', () => {
    const codes = validateCues([cue('a', 0, 1000), cue('b', 900, 1100, ''), cue('c', 2000, 2000), cue('d', 3000, 3600, 'x'.repeat(50))]).map((i) => `${i.cue}:${i.code}`);
    expect(codes).toEqual(expect.arrayContaining(['b:overlap', 'b:empty', 'c:duration', 'd:width', 'd:speed'])); expect(validateCues([cue('a', 0, 2000), cue('b', 2000, 4000)])).toEqual([]);
  });
  it('frame conversion is explicit, monotonic and keeps cues at least one frame', () => {
    const f = cuesToFrames([cue('a', 1000, 1010)], FPS.f29_97); expect(f[0]!.end - f[0]!.start).toBe(1);
    for (const r of [FPS.f23_976, FPS.f25, FPS.f29_97, FPS.f59_94]) for (let fr = 0; fr < 200000; fr += 997) expect(msToFrames(framesToMs(fr, r), r)).toBe(fr);
  });
  it('split / merge / trim keep timing consistent', () => {
    const [a, b] = splitCue(cue('1', 0, 4000, 'hello world'), 2000, 6, '2'); expect([a.text, b.text, a.endMs, b.startMs]).toEqual(['hello', 'world', 2000, 2000]);
    expect(mergeCues(b, a)).toMatchObject({ startMs: 0, endMs: 4000, text: 'hello\nworld' }); expect(() => splitCue(a, 0, 1, 'x')).toThrow(); expect(() => trimCue(a, 5, 5)).toThrow();
  });
});
