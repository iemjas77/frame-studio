import { current, isDraft } from 'immer';
import type { Id } from '@fs/project-model';

/** Per-transaction context: deterministic id generation (replay-safe) and touched-sequence tracking. */
export class Ctx {
  private n = 0;
  readonly touched = new Set<Id>();
  readonly range: { start: number; end: number } | null = null;
  private lo = Infinity; private hi = -Infinity;
  constructor(readonly txId: string) {}
  newId(prefix: string): Id { return `${prefix}_${this.txId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}_${++this.n}`; }
  touch(seqId: Id, a?: number, b?: number): void { this.touched.add(seqId); if (a !== undefined) this.lo = Math.min(this.lo, a); if (b !== undefined) this.hi = Math.max(this.hi, b); }
  dirtyRange(): { start: number; end: number } | null { return this.lo <= this.hi ? { start: this.lo, end: this.hi } : null; }
}
export const plain = <T>(x: T): T => structuredClone(isDraft(x) ? current(x) : x);
