import type { GameSummary, Snapshot, WorldInit } from '../shared/types.js';

export function normalizeSummary(raw: GameSummary): GameSummary {
  return {
    ...raw,
    awards: raw.awards ?? [],
  };
}

export function normalizeSnapshot(raw: Snapshot): Snapshot {
  return {
    ...raw,
    pings: raw.pings ?? [],
  };
}

export function cloneWorld(raw: WorldInit): WorldInit {
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

export function cloneSnapshot(raw: Snapshot): Snapshot {
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
