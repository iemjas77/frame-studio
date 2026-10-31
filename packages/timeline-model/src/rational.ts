/**
 * Exact rational arithmetic. All timing in Frame Studio is integer or rational;
 * floating point seconds are display-only and never fed back into the model.
 */
export type Rounding = 'floor' | 'ceil' | 'nearest' | 'trunc';

/** A rate or ratio as a reduced fraction of safe integers (den > 0). */
export interface Rate { readonly num: number; readonly den: number }

export const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a; b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
};

/** Exact fraction on bigint, always normalised (den > 0, reduced). */
export class Frac {
  readonly n: bigint; readonly d: bigint;
  private constructor(n: bigint, d: bigint) { this.n = n; this.d = d; }
  static of(n: bigint | number, d: bigint | number = 1): Frac {
    let N = BigInt(n), D = BigInt(d);
    if (D === 0n) throw new RangeError('Frac: zero denominator');
    if (D < 0n) { N = -N; D = -D; }
    const g = gcd(N, D) || 1n;
    return new Frac(N / g, D / g);
  }
  add(o: Frac): Frac { return Frac.of(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o: Frac): Frac { return Frac.of(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o: Frac): Frac { return Frac.of(this.n * o.n, this.d * o.d); }
  div(o: Frac): Frac { if (o.n === 0n) throw new RangeError('Frac: divide by zero'); return Frac.of(this.n * o.d, this.d * o.n); }
  neg(): Frac { return new Frac(-this.n, this.d); }
  cmp(o: Frac): -1 | 0 | 1 { const l = this.n * o.d, r = o.n * this.d; return l < r ? -1 : l > r ? 1 : 0; }
  eq(o: Frac): boolean { return this.cmp(o) === 0; }
  isInteger(): boolean { return this.d === 1n; }
  floor(): bigint { return this.n >= 0n ? this.n / this.d : -((-this.n + this.d - 1n) / this.d); }
  ceil(): bigint { return -this.neg().floor(); }
  /** Round to integer. 'nearest' rounds half away from zero (documented, deterministic). */
  round(mode: Rounding): bigint {
    switch (mode) {
      case 'floor': return this.floor();
      case 'ceil': return this.ceil();
      case 'trunc': return this.n / this.d;
      case 'nearest': {
        const twice = Frac.of(this.n * 2n + (this.n >= 0n ? this.d : -this.d), this.d * 2n);
        return twice.n / twice.d; // truncation toward zero of (x + sign/2)
      }
    }
  }
  toNumber(): number { return Number(this.n) / Number(this.d); } // display only
  toString(): string { return this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`; }
}

export const toSafeInt = (v: bigint, what = 'value'): number => {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError(`${what} exceeds safe integer range`);
  return Number(v);
};

export const rate = (num: number, den = 1): Rate => {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) throw new RangeError(`invalid rate ${num}/${den}`);
  const g = Number(gcd(BigInt(num), BigInt(den)));
  return { num: num / g, den: den / g };
};
export const rateFrac = (r: Rate): Frac => Frac.of(r.num, r.den);
export const rateEq = (a: Rate, b: Rate): boolean => a.num === b.num && a.den === b.den;

/** Standard frame rates, expressed exactly. */
export const FPS = {
  f23_976: rate(24000, 1001), f24: rate(24), f25: rate(25), f29_97: rate(30000, 1001),
  f30: rate(30), f50: rate(50), f59_94: rate(60000, 1001), f60: rate(60),
} as const;
