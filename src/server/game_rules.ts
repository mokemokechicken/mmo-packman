import type {
  Direction,
  FruitType,
  GhostType,
} from '../shared/types.js';

export type MoveDirection = Exclude<Direction, 'none'>;
export interface RandomSource {
  next: () => number;
}

export function pickGhostType(captureRatio: number, rng: RandomSource): GhostType {
  const roll = rng.next();

  if (captureRatio < 0.3) {
    return roll < 0.75 ? 'random' : 'chaser';
  }
  if (captureRatio < 0.6) {
    if (roll < 0.3) {
      return 'random';
    }
    if (roll < 0.55) {
      return 'chaser';
    }
    if (roll < 0.8) {
      return 'patrol';
    }
    return 'pincer';
  }
  if (captureRatio < 0.9) {
    if (roll < 0.2) {
      return 'random';
    }
    if (roll < 0.4) {
      return 'chaser';
    }
    if (roll < 0.6) {
      return 'patrol';
    }
    if (roll < 0.8) {
      return 'pincer';
    }
    return 'invader';
  }

  if (roll < 0.1) {
    return 'random';
  }
  if (roll < 0.25) {
    return 'chaser';
  }
  if (roll < 0.5) {
    return 'pincer';
  }
  if (roll < 0.8) {
    return 'invader';
  }
  return 'boss';
}

export function pickFruitType(rng: RandomSource): FruitType {
  const roll = rng.next();
  if (roll < 0.2) {
    return 'cherry';
  }
  if (roll < 0.35) {
    return 'grape';
  }
  if (roll < 0.5) {
    return 'orange';
  }
  if (roll < 0.65) {
    return 'strawberry';
  }
  if (roll < 0.82) {
    return 'key';
  }
  return 'apple';
}

export function oppositeOf(dir: Direction): MoveDirection | null {
  if (dir === 'up') {
    return 'down';
  }
  if (dir === 'down') {
    return 'up';
  }
  if (dir === 'left') {
    return 'right';
  }
  if (dir === 'right') {
    return 'left';
  }
  return null;
}

export function isMoveDirection(dir: Direction): dir is MoveDirection {
  return dir === 'up' || dir === 'down' || dir === 'left' || dir === 'right';
}
