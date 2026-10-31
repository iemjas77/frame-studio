import { randomUUID } from 'node:crypto';
import { Patch, applyPatches, enablePatches, produceWithPatches, setAutoFreeze } from 'immer';
import type { Id, ProjectDoc } from '@fs/project-model';
import { Command, applyCommand, assertInvariants } from './commands.ts';
import { Ctx } from './ctx.ts';
import { CommandError, fail } from './errors.ts';

enablePatches(); setAutoFreeze(true);

export interface HistoryEntry { label: string; patches: Patch[]; inverse: Patch[]; cost: number; touched: Id[] }
export interface Change { kind: 'execute' | 'undo' | 'redo' | 'gesture' | 'cancel' | 'load'; revision: number; touchedSequences: Id[]; dirty: { start: number; end: number } | null; label?: string }
export interface Committed { txId: string; command: Command }
export interface EngineOptions { maxHistoryEntries?: number; maxHistoryCost?: number; idSource?: () => string; onCommit?: (c: Committed | { history: 'undo' | 'redo' }) => void }

/**
 * Owns the authoritative ProjectDoc and its undo history. State is deeply frozen/immutable: consumers
 * (render, export, save) hold a snapshot that can never change underneath them.
 * `revision` increases on every state change (including undo/redo/gesture previews) and keys derived caches.
 */
export class CommandEngine {
  private _state: ProjectDoc; private _revision = 0;
  private undoStack: HistoryEntry[] = []; private redoStack: HistoryEntry[] = [];
  private listeners = new Set<(s: ProjectDoc, c: Change) => void>();
  private gesture: { key: string; label: string; base: ProjectDoc; last: { patches: Patch[]; inverse: Patch[] } | null; lastCommand: Command | null; touched: Set<Id> } | null = null;
  private cleanMarker = 0; private seq = 0; // position in history considered "saved"
  private readonly maxEntries: number; private readonly maxCost: number; private readonly newTxId: () => string;
  constructor(initial: ProjectDoc, private opts: EngineOptions = {}) {
    this._state = initial; this.maxEntries = opts.maxHistoryEntries ?? 500; this.maxCost = opts.maxHistoryCost ?? 4_000_000; this.newTxId = opts.idSource ?? randomUUID;
  }
  get state(): ProjectDoc { return this._state; }
  get revision(): number { return this._revision; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoLabel(): string | null { return this.undoStack.at(-1)?.label ?? null; }
  get redoLabel(): string | null { return this.redoStack.at(-1)?.label ?? null; }
  get historyDepth(): number { return this.undoStack.length; }
  get isDirty(): boolean { return this.cleanMarker !== this.seq || this.gesture !== null; }
  markClean(): void { this.cleanMarker = this.seq; }
  subscribe(fn: (s: ProjectDoc, c: Change) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(c: Change) { for (const l of this.listeners) l(this._state, c); }

  private run(base: ProjectDoc, cmd: Command, txId: string) {
    const ctx = new Ctx(txId);
    const [next, patches, inverse] = produceWithPatches(base, (d) => { applyCommand(d as ProjectDoc, cmd, ctx); assertInvariants(d as ProjectDoc); });
    return { next, patches, inverse, ctx };
  }
  private push(e: HistoryEntry) {
    this.undoStack.push(e); this.redoStack = []; this.seq++;
    let cost = this.undoStack.reduce((a, x) => a + x.cost, 0);
    while (this.undoStack.length > this.maxEntries || (cost > this.maxCost && this.undoStack.length > 1)) { cost -= this.undoStack.shift()!.cost; if (this.cleanMarker > 0) this.cleanMarker--; }
  }

  /** Execute one command as one atomic history entry. On any failure the state is untouched. */
  execute(cmd: Command, label?: string, txId = this.newTxId()): Change {
    if (this.gesture) fail('GestureState', 'a gesture is in progress; commit or cancel it first');
    const r = this.run(this._state, cmd, txId);
    if (r.patches.length === 0) fail('NothingToDo', 'command had no effect');
    this._state = r.next; this._revision++;
    const entry: HistoryEntry = { label: label ?? cmd.type, patches: r.patches, inverse: r.inverse, cost: JSON.stringify(r.patches).length, touched: [...r.ctx.touched] };
    this.push(entry); this.opts.onCommit?.({ txId, command: cmd });
    const c: Change = { kind: 'execute', revision: this._revision, touchedSequences: entry.touched, dirty: r.ctx.dirtyRange(), label: entry.label }; this.emit(c); return c;
  }
  /** Try a command without committing (e.g. to enable/disable UI). Never changes state. */
  dryRun(cmd: Command): { ok: true } | { ok: false; error: CommandError } {
    try { this.run(this._state, cmd, 'dryrun'); return { ok: true }; } catch (e) { if (e instanceof CommandError) return { ok: false, error: e }; throw e; }
  }

  /* ---- gestures: many previews, ONE history entry ---- */
  beginGesture(key: string, label: string): void {
    if (this.gesture) fail('GestureState', `gesture ${this.gesture.key} already active`);
    this.gesture = { key, label, base: this._state, last: null, lastCommand: null, touched: new Set() };
  }
  /** Replace the gesture's pending edit. Each update is evaluated from the gesture's BASE state, so updates never accumulate. A failing update leaves the previous preview in place and throws. */
  updateGesture(cmd: Command, txId = 'gesture'): Change {
    const g = this.gesture ?? fail('GestureState', 'no gesture active');
    const r = this.run(g.base, cmd, txId);
    g.last = { patches: r.patches, inverse: r.inverse }; g.lastCommand = cmd; r.ctx.touched.forEach((t) => g.touched.add(t));
    this._state = r.next; this._revision++;
    const c: Change = { kind: 'gesture', revision: this._revision, touchedSequences: [...g.touched], dirty: r.ctx.dirtyRange() }; this.emit(c); return c;
  }
  commitGesture(txId = this.newTxId()): Change | null {
    const g = this.gesture ?? fail('GestureState', 'no gesture active'); this.gesture = null;
    if (!g.last || g.last.patches.length === 0) { this._state = g.base; this._revision++; return null; }
    // Replay the final command with the committing txId so ids are reproducible from the journal.
    const r = this.run(g.base, g.lastCommand!, txId); this._state = r.next; this._revision++;
    const entry: HistoryEntry = { label: g.label, patches: r.patches, inverse: r.inverse, cost: JSON.stringify(r.patches).length, touched: [...r.ctx.touched] };
    this.push(entry); this.opts.onCommit?.({ txId, command: g.lastCommand! });
    const c: Change = { kind: 'execute', revision: this._revision, touchedSequences: entry.touched, dirty: r.ctx.dirtyRange(), label: g.label }; this.emit(c); return c;
  }
  cancelGesture(): void {
    const g = this.gesture ?? fail('GestureState', 'no gesture active'); this.gesture = null; this._state = g.base; this._revision++;
    this.emit({ kind: 'cancel', revision: this._revision, touchedSequences: [...g.touched], dirty: null });
  }
  get gestureActive(): boolean { return this.gesture !== null; }

  undo(): Change {
    if (this.gesture) fail('GestureState', 'finish the gesture before undo');
    const e = this.undoStack.pop() ?? fail('NothingToDo', 'nothing to undo');
    this._state = applyPatches(this._state, e.inverse) as ProjectDoc; this._revision++; this.redoStack.push(e); this.seq--;
    this.opts.onCommit?.({ history: 'undo' });
    const c: Change = { kind: 'undo', revision: this._revision, touchedSequences: e.touched, dirty: null, label: e.label }; this.emit(c); return c;
  }
  redo(): Change {
    if (this.gesture) fail('GestureState', 'finish the gesture before redo');
    const e = this.redoStack.pop() ?? fail('NothingToDo', 'nothing to redo');
    this._state = applyPatches(this._state, e.patches) as ProjectDoc; this._revision++; this.undoStack.push(e); this.seq++;
    this.opts.onCommit?.({ history: 'redo' });
    const c: Change = { kind: 'redo', revision: this._revision, touchedSequences: e.touched, dirty: null, label: e.label }; this.emit(c); return c;
  }
  /** Replace the whole document (open / revert). Clears history. */
  load(doc: ProjectDoc): void { this._state = doc; this._revision++; this.undoStack = []; this.redoStack = []; this.seq = 0; this.cleanMarker = 0; this.gesture = null; this.emit({ kind: 'load', revision: this._revision, touchedSequences: Object.keys(doc.sequences), dirty: null }); }
}
