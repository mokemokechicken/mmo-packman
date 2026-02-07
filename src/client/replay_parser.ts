import type { GameConfig, GameSummary, Snapshot, WorldInit } from '../shared/types.js';

export interface ReplayFrame {
  snapshot: Snapshot;
  dots: string[];
  pellets: Array<{
    key: string;
    x: number;
    y: number;
    active: boolean;
  }>;
}

export interface ReplayLog {
  format: 'mmo-packman-replay-v1';
  recordedAtIso: string;
  seed: number;
  config: GameConfig;
  world: WorldInit;
  startedAtMs: number;
  summary: GameSummary;
  frames: ReplayFrame[];
}

export function findReplayFrameIndex(offsets: number[], cursorMs: number): number {
  if (offsets.length === 0) {
    return 0;
  }
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const value = offsets[mid] as number;
    if (value <= cursorMs) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

export function parseReplayLog(raw: unknown): ReplayLog | null {
  if (!isRecordLike(raw)) {
    return null;
  }
  if (raw.format !== 'mmo-packman-replay-v1') {
    return null;
  }
  if (!Array.isArray(raw.frames) || raw.frames.length === 0) {
    return null;
  }
  if (!isRecordLike(raw.world) || !isRecordLike(raw.config) || !isRecordLike(raw.summary)) {
    return null;
  }
  if (typeof raw.seed !== 'number' || !Number.isFinite(raw.seed)) {
    return null;
  }
  if (typeof raw.startedAtMs !== 'number' || !Number.isFinite(raw.startedAtMs)) {
    return null;
  }

  const frames: ReplayFrame[] = [];
  for (const frameRaw of raw.frames) {
    if (!isRecordLike(frameRaw)) {
      return null;
    }
    if (!isRecordLike(frameRaw.snapshot) || !Array.isArray(frameRaw.dots) || !Array.isArray(frameRaw.pellets)) {
      return null;
    }

    const snapshotFrame = normalizeSnapshot(frameRaw.snapshot as unknown as Snapshot);
    if (typeof snapshotFrame.nowMs !== 'number' || typeof snapshotFrame.tick !== 'number') {
      return null;
    }

    const dots = frameRaw.dots.filter((item): item is string => typeof item === 'string');
    const pellets = frameRaw.pellets
      .filter((item): item is Record<string, unknown> => isRecordLike(item))
      .map((item) => ({
        key: typeof item.key === 'string' ? item.key : '',
        x: typeof item.x === 'number' ? item.x : 0,
        y: typeof item.y === 'number' ? item.y : 0,
        active: !!item.active,
      }))
      .filter((item) => item.key.length > 0);

    frames.push({
      snapshot: cloneSnapshot(snapshotFrame),
      dots,
      pellets,
    });
  }

  return {
    format: 'mmo-packman-replay-v1',
    recordedAtIso: typeof raw.recordedAtIso === 'string' ? raw.recordedAtIso : new Date().toISOString(),
    seed: raw.seed,
    config: raw.config as unknown as GameConfig,
    world: cloneWorld(raw.world as unknown as WorldInit),
    startedAtMs: raw.startedAtMs,
    summary: normalizeSummary(raw.summary as unknown as GameSummary),
    frames,
  };
}

function normalizeSummary(raw: GameSummary): GameSummary {
  return {
    ...raw,
    awards: raw.awards ?? [],
  };
}

function normalizeSnapshot(raw: Snapshot): Snapshot {
  return {
    ...raw,
    pings: raw.pings ?? [],
  };
}

function cloneWorld(raw: WorldInit): WorldInit {
  return {
    ...raw,
    tiles: [...raw.tiles],
    sectors: raw.sectors.map((sector) => ({ ...sector })),
    gates: raw.gates.map((gate) => ({
      ...gate,
      a: { ...gate.a },
      b: { ...gate.b },
      switchA: { ...gate.switchA },
      switchB: { ...gate.switchB },
    })),
    dots: raw.dots.map(([x, y]): [number, number] => [x, y]),
    powerPellets: raw.powerPellets.map((pellet) => ({ ...pellet })),
  };
}

function cloneSnapshot(raw: Snapshot): Snapshot {
  return {
    ...raw,
    players: raw.players.map((player) => ({ ...player })),
    ghosts: raw.ghosts.map((ghost) => ({ ...ghost })),
    fruits: raw.fruits.map((fruit) => ({ ...fruit })),
    sectors: raw.sectors.map((sector) => ({ ...sector })),
    gates: raw.gates.map((gate) => ({
      ...gate,
      a: { ...gate.a },
      b: { ...gate.b },
      switchA: { ...gate.switchA },
      switchB: { ...gate.switchB },
    })),
    pings: raw.pings.map((ping) => ({ ...ping })),
    events: raw.events.map((event) => ({ ...event })),
    timeline: raw.timeline.map((item) => ({ ...item })),
  };
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
