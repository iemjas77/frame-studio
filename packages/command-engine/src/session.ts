/** Node-only: an engine bound to a project file with journal, autosave and crash recovery. */
import * as fs from 'node:fs';
import { ProjectDoc, checksumOf, makeProject } from '@fs/project-model';
import { Recovered, journalAppend, journalClear, journalRead, journalStart, openProjectWithRecovery, saveProjectAtomic, writeAutosave } from '@fs/project-model/node';
import { Command } from './commands.ts';
import { CommandEngine, EngineOptions } from './engine.ts';

export const APP_VERSION = '0.1.0';
export interface OpenReport { source: Recovered['source'] | 'new'; journalReplayed: number; journalDropped: boolean; journalSkippedReason?: string; attempts: Recovered['attempts'] }

export class ProjectSession {
  readonly engine: CommandEngine; private savedChecksum: string;
  private constructor(readonly file: string, doc: ProjectDoc, opts: EngineOptions, readonly report: OpenReport) {
    this.savedChecksum = checksumOf(doc);
    this.engine = new CommandEngine(doc, { ...opts, onCommit: (c) => { journalAppend(file, { kind: 'tx', revision: this.engine?.revision ?? 0, txId: 'txId' in c ? c.txId : c.history, command: 'command' in c ? c.command : { $history: c.history } }); opts.onCommit?.(c); } });
  }
  static create(file: string, doc: ProjectDoc, opts: EngineOptions = {}): ProjectSession {
    saveProjectAtomic(file, doc, APP_VERSION); const s = new ProjectSession(file, doc, opts, { source: 'new', journalReplayed: 0, journalDropped: false, attempts: [] });
    journalStart(file, { kind: 'header', projectId: doc.id, baseChecksum: s.savedChecksum }); return s;
  }
  /** Open with fallback and replay the recovery journal on top of the saved base when it provably belongs to it. */
  static open(file: string, opts: EngineOptions = {}): ProjectSession {
    const rec = openProjectWithRecovery(file); const j = journalRead(file);
    const base = checksumOf(rec.project); let replay: { txId: string; command: unknown }[] = []; const rep: OpenReport = { source: rec.source, journalReplayed: 0, journalDropped: false, attempts: rec.attempts };
    if (j) {
      rep.journalDropped = j.droppedTail;
      if (j.header.baseChecksum === base) replay = j.entries; else rep.journalSkippedReason = `journal belongs to a different saved version (recovered from ${rec.source})`;
    }
    const s = new ProjectSession(file, rec.project, opts, rep);
    if (replay.length) {
      journalClear(file); journalStart(file, { kind: 'header', projectId: rec.project.id, baseChecksum: base });
      const quiet = new CommandEngine(rec.project, { maxHistoryEntries: opts.maxHistoryEntries });
      for (const e of replay) { const c = e.command as Command & { $history?: string }; if (c.$history === 'undo') quiet.undo(); else if (c.$history === 'redo') quiet.redo(); else quiet.execute(c, undefined, e.txId); rep.journalReplayed++; }
      // Re-enter the recovered state as normal history-free state; mark dirty because it differs from disk.
      s.engine.load(quiet.state); s.recoveredDirty = true;
      for (const e of replay) journalAppend(file, { kind: 'tx', revision: 0, txId: e.txId, command: e.command });
    } else if (j && j.header.baseChecksum !== base) { journalClear(file); journalStart(file, { kind: 'header', projectId: rec.project.id, baseChecksum: base }); }
    else if (!j) journalStart(file, { kind: 'header', projectId: rec.project.id, baseChecksum: base });
    return s;
  }
  recoveredDirty = false;
  get dirty(): boolean { return this.recoveredDirty || this.engine.isDirty; }
  save(): void {
    saveProjectAtomic(this.file, this.engine.state, APP_VERSION); this.savedChecksum = checksumOf(this.engine.state);
    journalStart(this.file, { kind: 'header', projectId: this.engine.state.id, baseChecksum: this.savedChecksum }); this.engine.markClean(); this.recoveredDirty = false;
  }
  autosave(): string { return writeAutosave(this.file, this.engine.state, APP_VERSION); }
  static exists(file: string): boolean { return fs.existsSync(file); }
}
export { makeProject };
