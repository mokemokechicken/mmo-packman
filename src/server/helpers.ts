let idSequence = 0;

export function keyOf(x: number, y: number): string {
  return `${x},${y}`;
}

export function parseKey(key: string): { x: number; y: number } {
  const [x, y] = key.split(',').map(Number);
  return { x, y };
}

export function makeId(prefix: string): string {
  idSequence = (idSequence + 1) >>> 0;
  return `${prefix}_${idSequence.toString(36).padStart(8, '0')}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function manhattan(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

export function nowMs(): number {
  return Date.now();
}
