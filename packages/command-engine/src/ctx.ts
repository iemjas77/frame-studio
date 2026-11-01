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
/** Deep copy that unwraps immer drafts at ANY depth (a new object created earlier in the same transaction may embed draft proxies). */
export function plain<T>(x: T): T {
  const walk = (v: unknown): unknown => {
    if (isDraft(v)) v = current(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, w]) => [k, walk(w)]));
    return v;
  };
  return walk(x) as T;
}
