import { randomUUID } from 'node:crypto';

export function keyOf(x: number, y: number): string {
  return `${x},${y}`;
}

export function parseKey(key: string): { x: number; y: number } {
  const [x, y] = key.split(',').map(Number);
  return { x, y };
}

export function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
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
