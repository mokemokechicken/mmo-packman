import type { ClientMessage, Difficulty } from '../shared/types.js';

const DIFFICULTIES = new Set<Difficulty>(['casual', 'normal', 'hard', 'nightmare']);
const MOVE_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || typeof value.type !== 'string') {
      return null;
    }

    if (value.type === 'hello') {
      if (typeof value.name !== 'string') {
        return null;
      }

      const reconnectToken =
        value.reconnectToken === undefined
          ? undefined
          : typeof value.reconnectToken === 'string'
            ? value.reconnectToken
            : null;
      const spectator =
        value.spectator === undefined ? undefined : typeof value.spectator === 'boolean' ? value.spectator : null;

      if (reconnectToken === null || spectator === null) {
        return null;
      }
      return {
        type: 'hello',
        name: value.name,
        reconnectToken,
        spectator,
      };
    }

    if (value.type === 'lobby_start') {
      const difficulty =
        value.difficulty === undefined
          ? undefined
          : typeof value.difficulty === 'string' && DIFFICULTIES.has(value.difficulty as Difficulty)
            ? (value.difficulty as Difficulty)
            : null;
      const aiPlayerCount =
        value.aiPlayerCount === undefined
          ? undefined
          : typeof value.aiPlayerCount === 'number' && Number.isFinite(value.aiPlayerCount)
            ? value.aiPlayerCount
            : null;
      const timeLimitMinutes =
        value.timeLimitMinutes === undefined
          ? undefined
          : typeof value.timeLimitMinutes === 'number' && Number.isFinite(value.timeLimitMinutes)
            ? value.timeLimitMinutes
            : null;

      if (difficulty === null || aiPlayerCount === null || timeLimitMinutes === null) {
        return null;
      }
      return {
        type: 'lobby_start',
        difficulty,
        aiPlayerCount,
        timeLimitMinutes,
      };
    }

    if (value.type === 'input') {
      const dir =
        value.dir === undefined
          ? undefined
          : typeof value.dir === 'string' && MOVE_DIRECTIONS.has(value.dir)
            ? (value.dir as 'up' | 'down' | 'left' | 'right')
            : null;
      const awaken = value.awaken === undefined ? undefined : typeof value.awaken === 'boolean' ? value.awaken : null;

      if (dir === null || awaken === null) {
        return null;
      }
      return {
        type: 'input',
        dir: dir as 'up' | 'down' | 'left' | 'right' | undefined,
        awaken,
      };
    }

    if (value.type === 'ping') {
      if (typeof value.t !== 'number' || !Number.isFinite(value.t)) {
        return null;
      }
      return {
        type: 'ping',
        t: value.t,
      };
    }

    return null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
