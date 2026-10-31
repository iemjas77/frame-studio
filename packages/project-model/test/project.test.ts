import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs'; import * as os from 'node:os'; import * as path from 'node:path';
import { FPS, time, rate, NORMAL_SPEED } from '@fs/timeline-model';
import { makeProject, makeSequence, validateProject, hasErrors,
  relativeTo, resolveRelative, candidatePaths, makePathRef, type ProjectDoc, type MediaRef } from '../src/index.ts';
import { serializeProject, parseProject, ProjectFormatError, canonicalJson, saveProjectAtomic, writeAutosave, listAutosaves, openProjectWithRecovery, journalStart, journalAppend, journalRead } from '../src/node.ts';

const media = (id = 'm1'): MediaRef => ({ id, name: 'a.mp4', binId: null, path: { absolute: '/media/a.mp4' }, fingerprint: { size: 1, headHash: 'h', tailHash: 't' },
  video: { codec: 'h264', width: 1920, height: 1080, rate: FPS.f25, duration: time(250, FPS.f25), rotation: 0, par: { num: 1, den: 1 }, colour: {} },
  audio: { codec: 'aac', sampleRate: 48000, channels: 2, duration: time(480000, rate(48000)) }, metadata: {} });
export const sample = (): ProjectDoc => {
  const p = makeProject('p1', 'Test', '2026-01-01T00:00:00.000Z'); p.mediaPool.m1 = media(); p.mediaOrder.push('m1');
  const s = makeSequence({ id: 's1', name: 'Seq' }); p.sequences.s1 = s; p.sequenceOrder.push('s1'); p.activeSequenceId = 's1';
  s.videoTracks[0]!.clips.push({ id: 'c1', name: 'a', mediaId: 'm1', stream: 'video', start: 0, duration: 100, sourceIn: time(10, FPS.f25), speed: NORMAL_SPEED, linkGroupId: 'L1', enabled: true });
  s.audioTracks[0]!.clips.push({ id: 'c2', name: 'a', mediaId: 'm1', stream: 'audio', start: 0, duration: 100, sourceIn: time(19200, rate(48000)), speed: NORMAL_SPEED, linkGroupId: 'L1', enabled: true });
  return p;
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fs-'));

describe('validation', () => {
  it('accepts a good project', () => expect(validateProject(sample())).toEqual([]));
  it('detects overlap, bad refs, source overrun, duplicate ids, bin cycles', () => {
    const p = sample(); const t = p.sequences.s1!.videoTracks[0]!;
    t.clips.push({ ...t.clips[0]!, id: 'c3', start: 50, linkGroupId: undefined });
    t.clips.push({ ...t.clips[0]!, id: 'c1', start: 500, mediaId: 'nope' });
    p.bins.a = { id: 'a', name: 'a', parentId: 'b' }; p.bins.b = { id: 'b', name: 'b', parentId: 'a' };
    const codes = validateProject(p).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['clip.overlap', 'ref.media', 'id.duplicate', 'bin.cycle']));
    const q = sample(); q.sequences.s1!.videoTracks[0]!.clips[0]!.duration = 300;
    expect(validateProject(q).map((i) => i.code)).toContain('clip.sourcebounds');
  });
  it('rejects drop-frame on 25 fps', () => { const p = sample(); p.sequences.s1!.dropFrame = true; expect(validateProject(p).map((i) => i.code)).toContain('seq.dropframe'); });
});

describe('format', () => {
  it('round trips byte-identically and preserves unknown fields', () => {
    const p = sample(); p.extensions.future = { a: [1, 2] }; (p as any).topLevelUnknown = 7; (p.sequences.s1 as any).newThing = { x: 1 };
    const text = serializeProject(p, '0.1.0', new Date(0));
    const r = parseProject(text); expect(r.project).toEqual(p); expect((r.project as any).topLevelUnknown).toBe(7);
    expect(serializeProject(r.project, '0.1.0', new Date(0))).toBe(text);
  });
  it('detects truncation, tampering, wrong format and newer schema', () => {
    const text = serializeProject(sample(), '0.1.0');
    expect(() => parseProject(text.slice(0, text.length / 2))).toThrow(/valid JSON/);
    expect(() => parseProject(text.replace('"Test"', '"Tampered"'))).toThrow(/checksum/);
    expect(() => parseProject('{"a":1}')).toThrow(/not a Frame Studio/);
    const newer = JSON.parse(text); newer.schemaVersion = 99;
    try { parseProject(JSON.stringify(newer)); expect.unreachable(); } catch (e) { expect((e as ProjectFormatError).code).toBe('newer-schema'); }
  });
  it('runs migrations one version at a time and keeps unknown fields', () => {
    const p = sample(); const text = serializeProject(p, '0.1.0');
    const old = JSON.parse(text); old.schemaVersion = 0; delete old.project.extensions; old.project.legacyField = 'keep';
    const r = parseProject(JSON.stringify(old), { currentVersion: 1, migrations: { 0: (d) => ({ ...d, extensions: {} }) } });
    expect(r.migratedFrom).toBe(0); expect((r.project as any).legacyField).toBe('keep');
    expect(() => parseProject(JSON.stringify(old), { currentVersion: 1, migrations: {} })).toThrow(/no migration/);
  });
  it('refuses to save an invalid project', () => { const p = sample(); p.sequences.s1!.videoTracks[0]!.clips[0]!.duration = 0; expect(() => serializeProject(p, 'x')).toThrow(/invalid/); });
  it('canonical json is key-order independent', () => expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: 1 }, b: 1 })));
});

describe('paths', () => {
  it('relative/absolute resolution, posix and windows', () => {
    expect(relativeTo('/proj/x', '/proj/media/a.mp4')).toBe('../media/a.mp4');
    expect(resolveRelative('/proj/x', '../media/a.mp4')).toBe('/proj/media/a.mp4');
    expect(relativeTo('C:\\Users\\me\\proj', 'C:\\Users\\me\\media\\a.mp4')).toBe('../media/a.mp4');
    expect(resolveRelative('D:\\proj', '../media/a.mp4')).toBe('D:\\media\\a.mp4');
    expect(relativeTo('C:\\proj', 'D:\\media\\a.mp4')).toBeUndefined();
    expect(candidatePaths(makePathRef('/p', '/p/m/a.mp4'), '/q')).toEqual(['/q/m/a.mp4', '/p/m/a.mp4']);
  });
});

describe('persistence (acceptance 7: interrupted save)', () => {
  it('atomic save keeps .bak and a crash before rename leaves the old file intact', () => {
    const d = tmp(); const f = path.join(d, 'p.fstudio'); const p = sample();
    saveProjectAtomic(f, p, '0.1.0'); const p2 = structuredClone(p); p2.name = 'Second';
    expect(() => saveProjectAtomic(f, p2, '0.1.0', { beforeRename: () => { throw new Error('power loss'); } })).toThrow('power loss');
    expect(openProjectWithRecovery(f).project.name).toBe('Test');
    expect(fs.readdirSync(d).some((n) => n.includes('.tmp-'))).toBe(false);
    saveProjectAtomic(f, p2, '0.1.0'); expect(openProjectWithRecovery(f).project.name).toBe('Second');
    expect(parseProject(fs.readFileSync(`${f}.bak`, 'utf8')).project.name).toBe('Test');
  });
  it('falls back main -> bak -> newest valid autosave and reports each attempt', () => {
    const d = tmp(); const f = path.join(d, 'p.fstudio'); const p = sample();
    saveProjectAtomic(f, p, '0.1.0'); p.name = 'v2'; saveProjectAtomic(f, p, '0.1.0');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').slice(0, 100)); // torn main
    let r = openProjectWithRecovery(f); expect(r.source).toBe('backup'); expect(r.project.name).toBe('Test'); expect(r.attempts[0]!.ok).toBe(false);
    fs.writeFileSync(`${f}.bak`, 'garbage'); p.name = 'auto'; writeAutosave(f, p, '0.1.0');
    r = openProjectWithRecovery(f); expect(r.source).toBe('autosave'); expect(r.project.name).toBe('auto');
    fs.rmSync(autosaveFiles(f)[0]!); expect(() => openProjectWithRecovery(f)).toThrow(/no readable project/);
  });
  it('rotates autosaves', () => {
    const d = tmp(); const f = path.join(d, 'p.fstudio'); const p = sample();
    for (let i = 0; i < 8; i++) { p.name = `n${i}`; writeAutosave(f, p, '0.1.0', 3); }
    const l = listAutosaves(f); expect(l.map((x) => x.seq)).toEqual([6, 7, 8]); expect(openProjectWithRecovery(f).project.name).toBe('n7');
  });
  it('journal drops a torn tail and detects corrupt lines', () => {
    const d = tmp(); const f = path.join(d, 'p.fstudio');
    journalStart(f, { kind: 'header', projectId: 'p1', baseChecksum: 'abc' });
    journalAppend(f, { kind: 'tx', revision: 4, txId: 'a', command: { type: 'x' } }); journalAppend(f, { kind: 'tx', revision: 5, txId: 'b', command: { type: 'y' } });
    fs.appendFileSync(`${f}.journal`, 'deadbeefdeadbeef {"kind":"tx","revision":6,"tx');
    const j = journalRead(f)!; expect(j.entries.map((e) => e.revision)).toEqual([4, 5]); expect(j.droppedTail).toBe(true);
  });
});
const autosaveFiles = (f: string) => listAutosaves(f).map((a) => a.file);
void hasErrors;
