import type {
  Difficulty,
  Direction,
  FruitType,
  GameOverReason,
  GhostType,
  PlayerState,
  RuntimeEvent,
  ScoreEntry,
  SectorType,
  ServerMessage,
} from '../shared/types.js';

const DIRECTIONS = new Set<Direction>(['up', 'down', 'left', 'right', 'none']);
const PLAYER_STATES = new Set<PlayerState>(['normal', 'power', 'down']);
const GHOST_TYPES = new Set<GhostType>(['random', 'chaser', 'patrol', 'pincer', 'invader', 'boss']);
const FRUIT_TYPES = new Set<FruitType>(['cherry', 'strawberry', 'orange', 'apple', 'key', 'grape']);
const SECTOR_TYPES = new Set<SectorType>(['normal', 'narrow', 'plaza', 'dark', 'fast', 'nest']);
const DIFFICULTIES = new Set<Difficulty>(['casual', 'normal', 'hard', 'nightmare']);
const GAME_OVER_REASONS = new Set<GameOverReason>(['victory', 'timeout', 'all_down', 'collapse']);
const MAX_SAFE_STOCKS = 20;

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return parseServerMessageValue(value);
  } catch {
    return null;
  }
}

function parseServerMessageValue(value: unknown): ServerMessage | null {
  if (!isRecord(value) || !isString(value.type)) {
    return null;
  }

  if (value.type === 'welcome') {
    if (!isString(value.playerId) || !isString(value.reconnectToken) || !isBoolean(value.isHost) || !isBoolean(value.isSpectator)) {
      return null;
    }
    return {
      type: 'welcome',
      playerId: value.playerId,
      reconnectToken: value.reconnectToken,
      isHost: value.isHost,
      isSpectator: value.isSpectator,
    };
  }

  if (value.type === 'lobby') {
    if (!isArray(value.players) || !isNullableString(value.hostId) || !isBoolean(value.canStart) || !isBoolean(value.running)) {
      return null;
    }
    if (!isNumber(value.spectatorCount) || (value.note !== undefined && !isString(value.note))) {
      return null;
    }

    const players = value.players.map(parseLobbyPlayer);
    if (players.some((player) => !player)) {
      return null;
    }
    return {
      type: 'lobby',
      players: players as NonNullable<typeof players[number]>[],
      hostId: value.hostId,
      canStart: value.canStart,
      running: value.running,
      spectatorCount: value.spectatorCount,
      note: value.note,
    };
  }

  if (value.type === 'game_init') {
    if (!isString(value.meId) || !isNumber(value.startedAtMs) || !isBoolean(value.isSpectator)) {
      return null;
    }
    const world = parseWorldInit(value.world);
    const config = parseGameConfig(value.config);
    if (!world || !config) {
      return null;
    }
    return {
      type: 'game_init',
      meId: value.meId,
      world,
      config,
      startedAtMs: value.startedAtMs,
      isSpectator: value.isSpectator,
    };
  }

  if (value.type === 'state') {
    const snapshot = parseSnapshot(value.snapshot);
    if (!snapshot) {
      return null;
    }
    return {
      type: 'state',
      snapshot,
    };
  }

  if (value.type === 'game_over') {
    const summary = parseGameSummary(value.summary);
    if (!summary) {
      return null;
    }
    return {
      type: 'game_over',
      summary,
    };
  }

  if (value.type === 'error') {
    if (!isString(value.message)) {
      return null;
    }
    return { type: 'error', message: value.message };
  }

  if (value.type === 'pong') {
    if (!isNumber(value.t)) {
      return null;
    }
    return { type: 'pong', t: value.t };
  }

  return null;
}

function parseLobbyPlayer(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isString(value.id) ||
    !isString(value.name) ||
    !isBoolean(value.connected) ||
    !isBoolean(value.ai) ||
    !isBoolean(value.spectator) ||
    !isBoolean(value.isHost)
  ) {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    connected: value.connected,
    ai: value.ai,
    spectator: value.spectator,
    isHost: value.isHost,
  };
}

function parseWorldInit(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  if (!isNumber(value.width) || !isNumber(value.height) || !isNumber(value.sectorSize) || !isNumber(value.side)) {
    return null;
  }
  if (!isArray(value.tiles) || value.tiles.some((tile) => !isString(tile))) {
    return null;
  }
  if (!isPositiveInteger(value.width) || !isPositiveInteger(value.height) || !isPositiveInteger(value.sectorSize) || !isPositiveInteger(value.side)) {
    return null;
  }
  if (value.tiles.length !== value.height) {
    return null;
  }
  if ((value.tiles as string[]).some((row) => row.length !== value.width)) {
    return null;
  }

  if (!isArray(value.sectors) || !isArray(value.gates) || !isArray(value.dots) || !isArray(value.powerPellets)) {
    return null;
  }

  const sectors = value.sectors.map(parseSector);
  const gates = value.gates.map(parseGate);
  const dots = value.dots.map(parseDot);
  const powerPellets = value.powerPellets.map(parsePowerPellet);
  if (
    sectors.some((sector) => !sector) ||
    gates.some((gate) => !gate) ||
    dots.some((dot) => !dot) ||
    powerPellets.some((pellet) => !pellet)
  ) {
    return null;
  }

  return {
    width: value.width,
    height: value.height,
    sectorSize: value.sectorSize,
    side: value.side,
    tiles: value.tiles as string[],
    sectors: sectors as NonNullable<typeof sectors[number]>[],
    gates: gates as NonNullable<typeof gates[number]>[],
    dots: dots as NonNullable<typeof dots[number]>[],
    powerPellets: powerPellets as NonNullable<typeof powerPellets[number]>[],
  };
}

function parseGameConfig(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isNumber(value.tickRate) ||
    !isNumber(value.dotsForAwaken) ||
    !isNumber(value.awakenMaxStock) ||
    !isNumber(value.powerDurationMs) ||
    !isNumber(value.awakenDurationMs) ||
    !isNumber(value.rescueTimeoutMs) ||
    !isNumber(value.timeLimitMs)
  ) {
    return null;
  }
  if (!isString(value.difficulty) || !DIFFICULTIES.has(value.difficulty as Difficulty)) {
    return null;
  }

  return {
    tickRate: value.tickRate,
    dotsForAwaken: value.dotsForAwaken,
    awakenMaxStock: value.awakenMaxStock,
    powerDurationMs: value.powerDurationMs,
    awakenDurationMs: value.awakenDurationMs,
    rescueTimeoutMs: value.rescueTimeoutMs,
    timeLimitMs: value.timeLimitMs,
    difficulty: value.difficulty as Difficulty,
  };
}

function parseSnapshot(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  if (!isNumber(value.tick) || !isNumber(value.nowMs) || !isNumber(value.timeLeftMs) || !isNumber(value.captureRatio)) {
    return null;
  }
  if (
    !isArray(value.players) ||
    !isArray(value.ghosts) ||
    !isArray(value.fruits) ||
    !isArray(value.sectors) ||
    !isArray(value.gates) ||
    !isArray(value.events) ||
    !isArray(value.timeline)
  ) {
    return null;
  }

  const players = value.players.map(parsePlayerView);
  const ghosts = value.ghosts.map(parseGhostView);
  const fruits = value.fruits.map(parseFruitView);
  const sectors = value.sectors.map(parseSector);
  const gates = value.gates.map(parseGate);
  const timeline = value.timeline.map(parseTimelineEvent);
  const events: RuntimeEvent[] = [];

  for (const rawEvent of value.events) {
    const parsed = parseRuntimeEvent(rawEvent);
    if (parsed === 'unknown') {
      continue;
    }
    if (parsed === 'invalid-known') {
      return null;
    }
    events.push(parsed);
  }

  if (
    players.some((item) => !item) ||
    ghosts.some((item) => !item) ||
    fruits.some((item) => !item) ||
    sectors.some((item) => !item) ||
    gates.some((item) => !item) ||
    timeline.some((item) => !item)
  ) {
    return null;
  }

  return {
    tick: value.tick,
    nowMs: value.nowMs,
    timeLeftMs: value.timeLeftMs,
    captureRatio: value.captureRatio,
    players: players as NonNullable<typeof players[number]>[],
    ghosts: ghosts as NonNullable<typeof ghosts[number]>[],
    fruits: fruits as NonNullable<typeof fruits[number]>[],
    sectors: sectors as NonNullable<typeof sectors[number]>[],
    gates: gates as NonNullable<typeof gates[number]>[],
    events,
    timeline: timeline as NonNullable<typeof timeline[number]>[],
  };
}

function parseGameSummary(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  if (!isString(value.reason) || !GAME_OVER_REASONS.has(value.reason as GameOverReason)) {
    return null;
  }
  if (!isNumber(value.durationMs) || !isNumber(value.captureRatio) || !isArray(value.timeline) || !isArray(value.ranking)) {
    return null;
  }

  const timeline = value.timeline.map(parseTimelineEvent);
  const ranking = value.ranking.map(parseScoreEntry);
  if (timeline.some((item) => !item) || ranking.some((item) => !item)) {
    return null;
  }

  return {
    reason: value.reason as GameOverReason,
    durationMs: value.durationMs,
    captureRatio: value.captureRatio,
    timeline: timeline as NonNullable<typeof timeline[number]>[],
    ranking: ranking as ScoreEntry[],
  };
}

function parsePlayerView(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isString(value.id) ||
    !isString(value.name) ||
    !isNumber(value.x) ||
    !isNumber(value.y) ||
    !isString(value.dir) ||
    !DIRECTIONS.has(value.dir as Direction) ||
    !isString(value.state) ||
    !PLAYER_STATES.has(value.state as PlayerState) ||
    !isNumber(value.stocks) ||
    !isNumber(value.gauge) ||
    !isNumber(value.gaugeMax) ||
    !isNumber(value.score) ||
    !isBoolean(value.connected) ||
    !isBoolean(value.ai) ||
    !isNumber(value.speedBuffUntil) ||
    !isNumber(value.powerUntil) ||
    !(isNumber(value.downSince) || value.downSince === null)
  ) {
    return null;
  }
  if (!isNonNegativeInteger(value.stocks)) {
    return null;
  }
  if (value.stocks > MAX_SAFE_STOCKS) {
    return null;
  }
  if (value.gauge < 0 || value.gaugeMax < 0 || value.gauge > value.gaugeMax) {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    x: value.x,
    y: value.y,
    dir: value.dir as Direction,
    state: value.state as PlayerState,
    stocks: value.stocks,
    gauge: value.gauge,
    gaugeMax: value.gaugeMax,
    score: value.score,
    connected: value.connected,
    ai: value.ai,
    speedBuffUntil: value.speedBuffUntil,
    powerUntil: value.powerUntil,
    downSince: value.downSince,
  };
}

function parseGhostView(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isString(value.id) ||
    !isNumber(value.x) ||
    !isNumber(value.y) ||
    !isString(value.dir) ||
    !DIRECTIONS.has(value.dir as Direction) ||
    !isString(value.type) ||
    !GHOST_TYPES.has(value.type as GhostType) ||
    !isNumber(value.hp) ||
    !isNumber(value.stunnedUntil)
  ) {
    return null;
  }

  return {
    id: value.id,
    x: value.x,
    y: value.y,
    dir: value.dir as Direction,
    type: value.type as GhostType,
    hp: value.hp,
    stunnedUntil: value.stunnedUntil,
  };
}

function parseFruitView(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  if (!isString(value.id) || !isString(value.type) || !FRUIT_TYPES.has(value.type as FruitType)) {
    return null;
  }
  if (!isNumber(value.x) || !isNumber(value.y) || !isNumber(value.spawnedAt)) {
    return null;
  }

  return {
    id: value.id,
    type: value.type as FruitType,
    x: value.x,
    y: value.y,
    spawnedAt: value.spawnedAt,
  };
}

function parseSector(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isNumber(value.id) ||
    !isNumber(value.row) ||
    !isNumber(value.col) ||
    !isNumber(value.x) ||
    !isNumber(value.y) ||
    !isNumber(value.size) ||
    !isString(value.type) ||
    !SECTOR_TYPES.has(value.type as SectorType) ||
    !isBoolean(value.discovered) ||
    !isBoolean(value.captured) ||
    !isNumber(value.dotCount) ||
    !isNumber(value.totalDots)
  ) {
    return null;
  }

  return {
    id: value.id,
    row: value.row,
    col: value.col,
    x: value.x,
    y: value.y,
    size: value.size,
    type: value.type as SectorType,
    discovered: value.discovered,
    captured: value.captured,
    dotCount: value.dotCount,
    totalDots: value.totalDots,
  };
}

function parseGate(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  if (!isString(value.id) || !isBoolean(value.open) || !isBoolean(value.permanent)) {
    return null;
  }
  const a = parseVec2(value.a);
  const b = parseVec2(value.b);
  const switchA = parseVec2(value.switchA);
  const switchB = parseVec2(value.switchB);
  if (!a || !b || !switchA || !switchB) {
    return null;
  }

  return {
    id: value.id,
    a,
    b,
    switchA,
    switchB,
    open: value.open,
    permanent: value.permanent,
  };
}

function parseVec2(value: unknown) {
  if (!isRecord(value) || !isNumber(value.x) || !isNumber(value.y)) {
    return null;
  }
  return {
    x: value.x,
    y: value.y,
  };
}

function parsePowerPellet(value: unknown) {
  if (!isRecord(value) || !isString(value.key) || !isNumber(value.x) || !isNumber(value.y) || !isBoolean(value.active)) {
    return null;
  }

  return {
    key: value.key,
    x: value.x,
    y: value.y,
    active: value.active,
  };
}

function parseDot(value: unknown): [number, number] | null {
  if (!isArray(value) || value.length !== 2 || !isNumber(value[0]) || !isNumber(value[1])) {
    return null;
  }
  return [value[0], value[1]];
}

function parseTimelineEvent(value: unknown) {
  if (!isRecord(value) || !isNumber(value.atMs) || !isString(value.label)) {
    return null;
  }
  return {
    atMs: value.atMs,
    label: value.label,
  };
}

function parseScoreEntry(value: unknown): ScoreEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isString(value.playerId) ||
    !isString(value.name) ||
    !isNumber(value.score) ||
    !isNumber(value.dots) ||
    !isNumber(value.ghosts) ||
    !isNumber(value.rescues) ||
    !isNumber(value.captures)
  ) {
    return null;
  }

  return {
    playerId: value.playerId,
    name: value.name,
    score: value.score,
    dots: value.dots,
    ghosts: value.ghosts,
    rescues: value.rescues,
    captures: value.captures,
  };
}

function parseRuntimeEvent(value: unknown): RuntimeEvent | 'unknown' | 'invalid-known' {
  if (!isRecord(value) || !isString(value.type)) {
    return 'invalid-known';
  }

  if (value.type === 'dot_eaten') {
    if (!isNumber(value.x) || !isNumber(value.y) || !isString(value.by)) {
      return 'invalid-known';
    }
    return { type: 'dot_eaten', x: value.x, y: value.y, by: value.by };
  }
  if (value.type === 'dot_respawned') {
    if (!isNumber(value.x) || !isNumber(value.y)) {
      return 'invalid-known';
    }
    return { type: 'dot_respawned', x: value.x, y: value.y };
  }
  if (value.type === 'pellet_taken') {
    if (!isString(value.key)) {
      return 'invalid-known';
    }
    return { type: 'pellet_taken', key: value.key };
  }
  if (value.type === 'pellet_respawned') {
    if (!isString(value.key)) {
      return 'invalid-known';
    }
    return { type: 'pellet_respawned', key: value.key };
  }
  if (value.type === 'player_down') {
    if (!isString(value.playerId)) {
      return 'invalid-known';
    }
    return { type: 'player_down', playerId: value.playerId };
  }
  if (value.type === 'player_revived') {
    if (!isString(value.playerId) || !isString(value.by) || !isBoolean(value.auto)) {
      return 'invalid-known';
    }
    return { type: 'player_revived', playerId: value.playerId, by: value.by, auto: value.auto };
  }
  if (value.type === 'sector_captured') {
    if (!isNumber(value.sectorId)) {
      return 'invalid-known';
    }
    return { type: 'sector_captured', sectorId: value.sectorId };
  }
  if (value.type === 'sector_lost') {
    if (!isNumber(value.sectorId)) {
      return 'invalid-known';
    }
    return { type: 'sector_lost', sectorId: value.sectorId };
  }
  if (value.type === 'fruit_spawned') {
    const fruit = parseFruitView(value.fruit);
    if (!fruit) {
      return 'invalid-known';
    }
    return { type: 'fruit_spawned', fruit };
  }
  if (value.type === 'fruit_taken') {
    if (!isString(value.fruitId) || !isString(value.by) || !isString(value.fruitType)) {
      return 'invalid-known';
    }
    if (!FRUIT_TYPES.has(value.fruitType as FruitType)) {
      return 'invalid-known';
    }
    return { type: 'fruit_taken', fruitId: value.fruitId, by: value.by, fruitType: value.fruitType as FruitType };
  }
  if (value.type === 'boss_spawned') {
    if (!isString(value.ghostId)) {
      return 'invalid-known';
    }
    return { type: 'boss_spawned', ghostId: value.ghostId };
  }
  if (value.type === 'boss_hit') {
    if (!isString(value.ghostId) || !isNumber(value.hp) || !isString(value.by)) {
      return 'invalid-known';
    }
    return { type: 'boss_hit', ghostId: value.ghostId, hp: value.hp, by: value.by };
  }
  if (value.type === 'toast') {
    if (!isString(value.message)) {
      return 'invalid-known';
    }
    return { type: 'toast', message: value.message };
  }

  return 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
