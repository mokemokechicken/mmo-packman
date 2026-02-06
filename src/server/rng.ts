export class Rng {
  private seed: number;

  public constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  public next(): number {
    this.seed += 0x6d2b79f5;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  public int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  public pick<T>(values: T[]): T {
    return values[this.int(0, values.length - 1)] as T;
  }

  public bool(probability = 0.5): boolean {
    return this.next() < probability;
  }
}
