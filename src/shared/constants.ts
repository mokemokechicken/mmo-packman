import type { Difficulty, Direction } from './types.js';

export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;

export const SECTOR_SIZE = 17;
export const DOTS_FOR_AWAKEN = 50;
export const MAX_AWAKEN_STOCK = 3;
export const POWER_DURATION_MS = 8000;
export const AWAKEN_DURATION_MS = 6000;
export const RESCUE_TIMEOUT_MS = 30000;
export const POWER_PELLET_RESPAWN_MS = 90000;

export const PLAYER_BASE_SPEED = 6;
export const PLAYER_CAPTURED_SPEED_MULTIPLIER = 1.2;
export const GHOST_BASE_SPEED = 4.6;

export const POWER_AURA_RADIUS = 5;

export const DIRECTION_VECTORS: Record<Exclude<Direction, 'none'>, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export function getMapSideByPlayerCount(playerCount: number): number {
  if (playerCount <= 5) {
    return 2;
  }
  if (playerCount <= 15) {
    return 3;
  }
  if (playerCount <= 30) {
    return 4;
  }
  if (playerCount <= 60) {
    return 5;
  }
  return 6;
}

export function getInitialGhostCount(playerCount: number): number {
  if (playerCount <= 1) {
    return 4;
  }
  if (playerCount <= 5) {
    return 8;
  }
  if (playerCount <= 15) {
    return 20;
  }
  if (playerCount <= 30) {
    return 40;
  }
  if (playerCount <= 60) {
    return 65;
  }
  return 100;
}

export function getTimeLimitMs(playerCount: number): number {
  if (playerCount <= 5) {
    return 15 * 60 * 1000;
  }
  if (playerCount <= 15) {
    return 18 * 60 * 1000;
  }
  if (playerCount <= 30) {
    return 22 * 60 * 1000;
  }
  if (playerCount <= 60) {
    return 26 * 60 * 1000;
  }
  return 30 * 60 * 1000;
}

export function getDifficultyMultiplier(difficulty: Difficulty): { ghostSpeed: number; maintenance: number } {
  if (difficulty === 'casual') {
    return { ghostSpeed: 0.8, maintenance: 0.6 };
  }
  if (difficulty === 'hard') {
    return { ghostSpeed: 1.2, maintenance: 1.4 };
  }
  if (difficulty === 'nightmare') {
    return { ghostSpeed: 1.5, maintenance: 2.0 };
  }
  return { ghostSpeed: 1.0, maintenance: 1.0 };
}

export function getCapturePressure(captureRatio: number): { graceMs: number; regenMultiplier: number } {
  if (captureRatio <= 0.3) {
    return { graceMs: 120_000, regenMultiplier: 1.0 };
  }
  if (captureRatio <= 0.5) {
    return { graceMs: 90_000, regenMultiplier: 1.3 };
  }
  if (captureRatio <= 0.7) {
    return { graceMs: 60_000, regenMultiplier: 1.8 };
  }
  if (captureRatio <= 0.85) {
    return { graceMs: 40_000, regenMultiplier: 2.5 };
  }
  if (captureRatio <= 0.95) {
    return { graceMs: 25_000, regenMultiplier: 3.5 };
  }
  return { graceMs: 15_000, regenMultiplier: 5.0 };
}
