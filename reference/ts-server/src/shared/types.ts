export type Direction = 'up' | 'down' | 'left' | 'right' | 'none';
export type PlayerState = 'normal' | 'power' | 'down';
export type GhostType = 'random' | 'chaser' | 'patrol' | 'pincer' | 'invader' | 'boss';
export type SectorType = 'normal' | 'narrow' | 'plaza' | 'dark' | 'fast' | 'nest';
export type FruitType = 'cherry' | 'strawberry' | 'orange' | 'apple' | 'key' | 'grape';
export type Difficulty = 'casual' | 'normal' | 'hard' | 'nightmare';
export type GameOverReason = 'victory' | 'timeout' | 'all_down' | 'collapse';
export type PingType = 'focus' | 'danger' | 'help';

export interface Vec2 {
  x: number;
  y: number;
}

export interface LobbyPlayer {
  id: string;
  name: string;
  connected: boolean;
  ai: boolean;
  spectator: boolean;
  isHost: boolean;
}

export interface GateState {
  id: string;
  a: Vec2;
  b: Vec2;
  switchA: Vec2;
  switchB: Vec2;
  open: boolean;
  permanent: boolean;
}

export interface SectorState {
  id: number;
  row: number;
  col: number;
  x: number;
  y: number;
  size: number;
  type: SectorType;
  discovered: boolean;
  captured: boolean;
  dotCount: number;
  totalDots: number;
}

export interface WorldInit {
  width: number;
  height: number;
  sectorSize: number;
  side: number;
  tiles: string[];
  sectors: SectorState[];
  gates: GateState[];
  dots: Array<[number, number]>;
  powerPellets: Array<{ key: string; x: number; y: number; active: boolean }>;
}

export interface GameConfig {
  tickRate: number;
  dotsForAwaken: number;
  awakenMaxStock: number;
  powerDurationMs: number;
  awakenDurationMs: number;
  rescueTimeoutMs: number;
  timeLimitMs: number;
  difficulty: Difficulty;
}

export interface PlayerView {
  id: string;
  name: string;
  x: number;
  y: number;
  dir: Direction;
  state: PlayerState;
  stocks: number;
  gauge: number;
  gaugeMax: number;
  score: number;
  connected: boolean;
  ai: boolean;
  speedBuffUntil: number;
  powerUntil: number;
  downSince: number | null;
}

export interface GhostView {
  id: string;
  x: number;
  y: number;
  dir: Direction;
  type: GhostType;
  hp: number;
  stunnedUntil: number;
}

export interface FruitView {
  id: string;
  type: FruitType;
  x: number;
  y: number;
  spawnedAt: number;
}

export interface PingView {
  id: string;
  ownerId: string;
  ownerName: string;
  x: number;
  y: number;
  kind: PingType;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface TimelineEvent {
  atMs: number;
  label: string;
}

export type RuntimeEvent =
  | { type: 'dot_eaten'; x: number; y: number; by: string }
  | { type: 'dot_respawned'; x: number; y: number }
  | { type: 'pellet_taken'; key: string }
  | { type: 'pellet_respawned'; key: string }
  | { type: 'player_down'; playerId: string }
  | { type: 'player_revived'; playerId: string; by: string; auto: boolean }
  | { type: 'sector_captured'; sectorId: number }
  | { type: 'sector_lost'; sectorId: number }
  | { type: 'fruit_spawned'; fruit: FruitView }
  | { type: 'fruit_taken'; fruitId: string; by: string; fruitType: FruitType }
  | { type: 'boss_spawned'; ghostId: string }
  | { type: 'boss_hit'; ghostId: string; hp: number; by: string }
  | { type: 'toast'; message: string };

export interface Snapshot {
  tick: number;
  nowMs: number;
  timeLeftMs: number;
  captureRatio: number;
  players: PlayerView[];
  ghosts: GhostView[];
  fruits: FruitView[];
  sectors: SectorState[];
  gates: GateState[];
  pings: PingView[];
  events: RuntimeEvent[];
  timeline: TimelineEvent[];
}

export interface ScoreEntry {
  playerId: string;
  name: string;
  score: number;
  dots: number;
  ghosts: number;
  rescues: number;
  captures: number;
}

export interface PersistentRankingEntry {
  name: string;
  matches: number;
  wins: number;
  winRate: number;
  avgCaptureRatio: number;
  avgRescues: number;
  bestScore: number;
  updatedAtMs: number;
}

export interface RankingResponse {
  generatedAtIso: string;
  entries: PersistentRankingEntry[];
}

export interface GameSummary {
  reason: GameOverReason;
  durationMs: number;
  captureRatio: number;
  timeline: TimelineEvent[];
  ranking: ScoreEntry[];
}

export type ClientMessage =
  | { type: 'hello'; name: string; reconnectToken?: string; spectator?: boolean; roomId?: string }
  | { type: 'lobby_start'; difficulty?: Difficulty; aiPlayerCount?: number; timeLimitMinutes?: number }
  | { type: 'input'; dir?: Exclude<Direction, 'none'>; awaken?: boolean }
  | { type: 'place_ping'; kind: PingType }
  | { type: 'ping'; t: number };

export type ServerMessage =
  | {
      type: 'welcome';
      playerId: string;
      reconnectToken: string;
      isHost: boolean;
      isSpectator: boolean;
    }
  | {
      type: 'lobby';
      players: LobbyPlayer[];
      hostId: string | null;
      canStart: boolean;
      running: boolean;
      spectatorCount: number;
      note?: string;
    }
  | {
      type: 'game_init';
      meId: string;
      world: WorldInit;
      config: GameConfig;
      startedAtMs: number;
      seed: number;
      isSpectator: boolean;
    }
  | {
      type: 'state';
      snapshot: Snapshot;
    }
  | {
      type: 'game_over';
      summary: GameSummary;
    }
  | {
      type: 'error';
      message: string;
    }
  | {
      type: 'pong';
      t: number;
    };
