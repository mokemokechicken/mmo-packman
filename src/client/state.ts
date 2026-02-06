import type {
  FruitView,
  GameConfig,
  GameSummary,
  GhostView,
  RuntimeEvent,
  Snapshot,
  WorldInit,
} from '../shared/types.js';

export interface InterpolationState {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  updatedAtMs: number;
}

export type MoveDirection = 'up' | 'down' | 'left' | 'right' | 'none';

export interface PelletState {
  x: number;
  y: number;
  active: boolean;
}

export interface ClientState {
  reconnectToken: string;
  playerName: string;
  preferSpectator: boolean;
  requestedAiCount: number;
  requestedTestMinutes: number;
  sessionId: string;
  meId: string;
  isHost: boolean;
  isSpectator: boolean;
  world: WorldInit | null;
  config: GameConfig | null;
  snapshot: Snapshot | null;
  summary: GameSummary | null;
  lobbyMessage: string;
  logs: string[];
  currentDir: MoveDirection;
  followPlayerId: string | null;
  latestSnapshotReceivedAtMs: number;
  dotSet: Set<string>;
  pelletMap: Map<string, PelletState>;
  playerInterpolation: Map<string, InterpolationState>;
  ghostInterpolation: Map<string, InterpolationState>;
}

export function createClientState(): ClientState {
  const reconnectToken = localStorage.getItem('mmo-packman-token') ?? '';
  const playerName = localStorage.getItem('mmo-packman-name') ?? `Player-${Math.floor(Math.random() * 1000)}`;
  const preferSpectator = localStorage.getItem('mmo-packman-spectator') === '1';
  const requestedAiCount = normalizeNumber(localStorage.getItem('mmo-packman-ai-count'), 2, 0, 100);
  const requestedTestMinutes = normalizeNumber(localStorage.getItem('mmo-packman-test-minutes'), 5, 1, 10);

  return {
    reconnectToken,
    playerName,
    preferSpectator,
    requestedAiCount,
    requestedTestMinutes,
    sessionId: '',
    meId: '',
    isHost: false,
    isSpectator: preferSpectator,
    world: null,
    config: null,
    snapshot: null,
    summary: null,
    lobbyMessage: '',
    logs: [],
    currentDir: 'none',
    followPlayerId: null,
    latestSnapshotReceivedAtMs: performance.now(),
    dotSet: new Set<string>(),
    pelletMap: new Map<string, PelletState>(),
    playerInterpolation: new Map<string, InterpolationState>(),
    ghostInterpolation: new Map<string, InterpolationState>(),
  };
}

export function resetForGameInit(
  state: ClientState,
  payload: {
    meId: string;
    world: WorldInit;
    config: GameConfig;
    isSpectator: boolean;
  },
): void {
  state.meId = payload.meId;
  state.world = payload.world;
  state.config = payload.config;
  state.currentDir = 'none';
  state.isSpectator = payload.isSpectator;
  state.summary = null;
  state.logs = [];
  state.followPlayerId = null;
  state.playerInterpolation.clear();
  state.ghostInterpolation.clear();
  state.latestSnapshotReceivedAtMs = performance.now();
  state.dotSet.clear();
  state.pelletMap.clear();

  for (const [x, y] of payload.world.dots) {
    state.dotSet.add(dotKey(x, y));
  }
  for (const pellet of payload.world.powerPellets) {
    state.pelletMap.set(pellet.key, { x: pellet.x, y: pellet.y, active: pellet.active });
  }
}

export function applyRuntimeEvent(state: ClientState, event: RuntimeEvent): void {
  if (event.type === 'dot_eaten') {
    state.dotSet.delete(dotKey(event.x, event.y));
    return;
  }
  if (event.type === 'dot_respawned') {
    state.dotSet.add(dotKey(event.x, event.y));
    return;
  }
  if (event.type === 'pellet_taken') {
    const pellet = state.pelletMap.get(event.key);
    if (pellet) {
      pellet.active = false;
    }
    return;
  }
  if (event.type === 'pellet_respawned') {
    const pellet = state.pelletMap.get(event.key);
    if (pellet) {
      pellet.active = true;
    }
    return;
  }
  if (event.type === 'fruit_spawned') {
    pushLog(state, `フルーツ出現: ${fruitLabel(event.fruit.type)}`);
    return;
  }
  if (event.type === 'fruit_taken') {
    pushLog(state, `${playerNameById(state, event.by)} が ${fruitLabel(event.fruitType)} を取得`);
    return;
  }
  if (event.type === 'player_down') {
    pushLog(state, `${playerNameById(state, event.playerId)} がダウン`);
    return;
  }
  if (event.type === 'player_revived') {
    if (event.auto) {
      pushLog(state, `${playerNameById(state, event.playerId)} が自動復活`);
    } else {
      pushLog(state, `${playerNameById(state, event.by)} が ${playerNameById(state, event.playerId)} を救出`);
    }
    return;
  }
  if (event.type === 'sector_captured') {
    pushLog(state, `エリア ${event.sectorId} 制覇`);
    return;
  }
  if (event.type === 'sector_lost') {
    pushLog(state, `エリア ${event.sectorId} が劣化`);
    return;
  }
  if (event.type === 'boss_spawned') {
    pushLog(state, 'ボスゴースト出現');
    return;
  }
  if (event.type === 'boss_hit') {
    pushLog(state, `ボスにヒット (${event.hp}/3)`);
    return;
  }
  if (event.type === 'toast') {
    pushLog(state, event.message);
  }
}

export function pushLog(state: ClientState, line: string): void {
  state.logs.push(line);
  if (state.logs.length > 32) {
    state.logs = state.logs.slice(state.logs.length - 32);
  }
}

export function resolveFocusPlayer(state: ClientState) {
  if (!state.snapshot) {
    return null;
  }
  if (!state.isSpectator) {
    return state.snapshot.players.find((player) => player.id === state.meId) ?? null;
  }

  const members = state.snapshot.players;
  if (members.length === 0) {
    return null;
  }

  let follow = state.followPlayerId ? members.find((player) => player.id === state.followPlayerId) : undefined;
  if (!follow) {
    follow = [...members].sort((a, b) => b.score - a.score)[0];
    state.followPlayerId = follow?.id ?? null;
  }

  return follow ?? null;
}

export function currentFollowName(state: ClientState): string {
  if (!state.snapshot || !state.followPlayerId) {
    return 'auto';
  }
  const found = state.snapshot.players.find((player) => player.id === state.followPlayerId);
  return found?.name ?? 'auto';
}

export function playerNameById(state: ClientState, playerId: string): string {
  const found = state.snapshot?.players.find((player) => player.id === playerId);
  return found?.name ?? playerId.slice(0, 5);
}

export function fruitLabel(type: FruitView['type']): string {
  if (type === 'cherry') {
    return 'チェリー';
  }
  if (type === 'strawberry') {
    return 'ストロベリー';
  }
  if (type === 'orange') {
    return 'オレンジ';
  }
  if (type === 'apple') {
    return 'アップル';
  }
  if (type === 'key') {
    return 'キー';
  }
  return 'グレープ';
}

export function fruitColor(type: FruitView['type']): string {
  if (type === 'cherry') {
    return '#ff4f7b';
  }
  if (type === 'strawberry') {
    return '#ff3366';
  }
  if (type === 'orange') {
    return '#ff9a3d';
  }
  if (type === 'apple') {
    return '#9ff16f';
  }
  if (type === 'key') {
    return '#ffd86f';
  }
  return '#9b7dff';
}

export function ghostColor(type: GhostView['type']): string {
  if (type === 'random') {
    return '#ef556b';
  }
  if (type === 'chaser') {
    return '#ff7ec0';
  }
  if (type === 'patrol') {
    return '#6fd9ff';
  }
  if (type === 'pincer') {
    return '#ffac6f';
  }
  if (type === 'invader') {
    return '#9c62ff';
  }
  return '#121212';
}

export function formatMs(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const mm = Math.floor(sec / 60)
    .toString()
    .padStart(2, '0');
  const ss = Math.floor(sec % 60)
    .toString()
    .padStart(2, '0');
  return `${mm}:${ss}`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function dotKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function normalizeNumber(input: string | null, fallback: number, min: number, max: number): number {
  const n = Number(input ?? '');
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return clampNumber(Math.floor(n), min, max);
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
