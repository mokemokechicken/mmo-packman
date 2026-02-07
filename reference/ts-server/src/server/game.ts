import {
  AWAKEN_DURATION_MS,
  DOTS_FOR_AWAKEN,
  DIRECTION_VECTORS,
  GHOST_BASE_SPEED,
  MAX_AWAKEN_STOCK,
  PLAYER_BASE_SPEED,
  PLAYER_CAPTURED_SPEED_MULTIPLIER,
  POWER_AURA_RADIUS,
  POWER_DURATION_MS,
  POWER_PELLET_RESPAWN_MS,
  RESCUE_TIMEOUT_MS,
  TICK_RATE,
  getCapturePressure,
  getDifficultyMultiplier,
  getInitialGhostCount,
  getTimeLimitMs,
} from '../shared/constants.js';
import type {
  Difficulty,
  Direction,
  FruitView,
  GameConfig,
  GameOverReason,
  GameSummary,
  GhostType,
  GhostView,
  PlayerState,
  PlayerView,
  RuntimeEvent,
  ScoreEntry,
  SectorState,
  Snapshot,
  TimelineEvent,
  Vec2,
} from '../shared/types.js';
import { clamp, keyOf, makeId, manhattan } from './helpers.js';
import {
  isGateCellOrSwitch,
} from './gate_utils.js';
import {
  isMoveDirection,
  oppositeOf,
  pickFruitType,
  pickGhostType,
  type MoveDirection,
} from './game_rules.js';
import { Rng } from './rng.js';
import {
  type GeneratedWorld,
  generateWorld,
  toWorldInit,
} from './world.js';

interface PlayerStats {
  dots: number;
  ghosts: number;
  rescues: number;
  captures: number;
}

const AUTO_RESPAWN_GRACE_MS = 2_000;

interface PlayerInternal extends PlayerView {
  desiredDir: Direction;
  moveBuffer: number;
  spawn: Vec2;
  reconnectToken: string;
  awakenRequested: boolean;
  nextAuraMultiplier: number;
  remoteReviveGraceUntil: number;
  aiThinkAt: number;
  holdUntilMs: number;
  stats: PlayerStats;
}

interface GhostInternal extends GhostView {
  moveBuffer: number;
}

interface FruitInternal extends FruitView {}

export interface StartPlayer {
  id: string;
  name: string;
  reconnectToken: string;
  connected: boolean;
}

export interface GameEngineOptions {
  timeLimitMsOverride?: number;
}

export class GameEngine {
  public readonly startedAtMs: number;
  public readonly seed: number;
  public readonly config: GameConfig;
  public readonly world: GeneratedWorld;

  private readonly rng: Rng;
  private readonly players = new Map<string, PlayerInternal>();
  private readonly ghosts = new Map<string, GhostInternal>();
  private readonly fruits = new Map<string, FruitInternal>();
  private readonly events: RuntimeEvent[] = [];
  private readonly timeline: TimelineEvent[] = [];
  private readonly difficultyMultiplier: { ghostSpeed: number; maintenance: number };
  private readonly maxGhosts: number;
  private readonly playerCount: number;

  private elapsedMs = 0;
  private ended = false;
  private endReason: GameOverReason | null = null;
  private tickCounter = 0;
  private lastFruitSpawnMs = 0;
  private maxCaptureRatio = 0;
  private milestoneEmitted = new Set<number>();

  public constructor(
    startPlayers: StartPlayer[],
    difficulty: Difficulty = 'normal',
    seed = Date.now(),
    options: GameEngineOptions = {},
  ) {
    this.seed = seed;
    this.rng = new Rng(seed);
    this.playerCount = startPlayers.length;
    this.startedAtMs = Date.now();
    this.world = generateWorld(this.playerCount, seed);
    this.maxGhosts = getInitialGhostCount(this.playerCount);
    this.difficultyMultiplier = getDifficultyMultiplier(difficulty);
    this.config = {
      tickRate: TICK_RATE,
      dotsForAwaken: DOTS_FOR_AWAKEN,
      awakenMaxStock: MAX_AWAKEN_STOCK,
      powerDurationMs: POWER_DURATION_MS,
      awakenDurationMs: AWAKEN_DURATION_MS,
      rescueTimeoutMs: RESCUE_TIMEOUT_MS,
      timeLimitMs: options.timeLimitMsOverride ?? getTimeLimitMs(this.playerCount),
      difficulty,
    };

    const spawns = [...this.world.playerSpawnCells];
    if (spawns.length === 0) {
      spawns.push({ x: 1, y: 1 });
    }

    for (let index = 0; index < startPlayers.length; index += 1) {
      const start = startPlayers[index] as StartPlayer;
      const spawn = spawns[index % spawns.length] as Vec2;
      const player: PlayerInternal = {
        id: start.id,
        name: start.name,
        x: spawn.x,
        y: spawn.y,
        dir: 'none',
        desiredDir: 'none',
        state: 'normal',
        stocks: 0,
        gauge: 0,
        gaugeMax: DOTS_FOR_AWAKEN,
        score: 0,
        connected: start.connected,
        ai: !start.connected,
        speedBuffUntil: 0,
        powerUntil: 0,
        downSince: null,
        moveBuffer: 0,
        spawn,
        reconnectToken: start.reconnectToken,
        awakenRequested: false,
        nextAuraMultiplier: 1,
        remoteReviveGraceUntil: 0,
        aiThinkAt: 0,
        holdUntilMs: 0,
        stats: {
          dots: 0,
          ghosts: 0,
          rescues: 0,
          captures: 0,
        },
      };
      this.players.set(player.id, player);

      const sector = this.getSectorAt(spawn.x, spawn.y);
      if (sector && !sector.discovered) {
        sector.discovered = true;
      }
    }

    this.spawnInitialGhosts();
    this.timeline.push({ atMs: 0, label: 'ゲーム開始' });
  }

  public isRunning(): boolean {
    return !this.ended;
  }

  public isEnded(): boolean {
    return this.ended;
  }

  public getEndReason(): GameOverReason | null {
    return this.endReason;
  }

  public getWorldInit() {
    return toWorldInit(this.world);
  }

  public getReconnectToken(playerId: string): string | null {
    return this.players.get(playerId)?.reconnectToken ?? null;
  }

  public hasPlayer(playerId: string): boolean {
    return this.players.has(playerId);
  }

  public getNowMs(): number {
    return this.startedAtMs + this.elapsedMs;
  }

  public getPlayerPosition(playerId: string): Vec2 | null {
    const player = this.players.get(playerId);
    if (!player) {
      return null;
    }
    return { x: player.x, y: player.y };
  }

  public getPlayerByToken(token: string): PlayerInternal | null {
    for (const player of this.players.values()) {
      if (player.reconnectToken === token) {
        return player;
      }
    }
    return null;
  }

  public setPlayerConnection(playerId: string, connected: boolean): void {
    const player = this.players.get(playerId);
    if (!player) {
      return;
    }
    player.connected = connected;
    player.ai = !connected;
  }

  public receiveInput(playerId: string, input: { dir?: Direction; awaken?: boolean }): void {
    const player = this.players.get(playerId);
    if (!player || player.ai) {
      return;
    }

    if (input.dir) {
      if (!isMoveDirection(input.dir)) {
        return;
      }
      player.desiredDir = input.dir;
    }
    if (input.awaken) {
      player.awakenRequested = true;
    }
  }

  public step(dtMs: number): void {
    if (this.ended) {
      return;
    }

    this.tickCounter += 1;
    this.elapsedMs += dtMs;
    const nowMs = this.startedAtMs + this.elapsedMs;
    const playerPositionsBeforeMove = this.capturePlayerPositions();
    const ghostPositionsBeforeMove = this.captureGhostPositions();

    this.updateGates();
    this.updatePowerPellets(nowMs);
    this.updateFruitSpawner(nowMs);
    this.updatePlayers(dtMs, nowMs);
    this.updateGhosts(dtMs, nowMs);
    this.resolveGhostCollisions(nowMs, playerPositionsBeforeMove, ghostPositionsBeforeMove);
    this.updateSectorControl(dtMs, nowMs);

    if (this.tickCounter % TICK_RATE === 0) {
      this.adjustGhostPopulation(nowMs);
      this.recordMilestones();
    }

    this.checkGameOver(nowMs);
  }

  public buildSnapshot(drainEvents = true): Snapshot {
    return {
      tick: this.tickCounter,
      nowMs: this.startedAtMs + this.elapsedMs,
      timeLeftMs: Math.max(0, this.config.timeLimitMs - this.elapsedMs),
      captureRatio: this.captureRatio(),
      players: Array.from(this.players.values()).map((player) => this.toPlayerView(player)),
      ghosts: Array.from(this.ghosts.values()).map((ghost) => ({ ...ghost })),
      fruits: Array.from(this.fruits.values()).map((fruit) => ({ ...fruit })),
      sectors: this.world.sectors.map((sector) => this.toSectorView(sector)),
      gates: this.world.gates.map((gate) => ({ ...gate })),
      pings: [],
      events: drainEvents ? this.events.splice(0, this.events.length) : [...this.events],
      timeline: this.timeline.slice(Math.max(0, this.timeline.length - 50)),
    };
  }

  public buildSummary(): GameSummary {
    const ranking = Array.from(this.players.values())
      .map((player): ScoreEntry => ({
        playerId: player.id,
        name: player.name,
        score: player.score,
        dots: player.stats.dots,
        ghosts: player.stats.ghosts,
        rescues: player.stats.rescues,
        captures: player.stats.captures,
      }))
      .sort((a, b) => b.score - a.score);

    return {
      reason: this.endReason ?? 'timeout',
      durationMs: this.elapsedMs,
      captureRatio: this.captureRatio(),
      timeline: this.timeline,
      ranking,
    };
  }

  private toPlayerView(player: PlayerInternal): PlayerView {
    const out: PlayerView = {
      id: player.id,
      name: player.name,
      x: player.x,
      y: player.y,
      dir: player.dir,
      state: player.state,
      stocks: player.stocks,
      gauge: player.gauge,
      gaugeMax: player.gaugeMax,
      score: player.score,
      connected: player.connected,
      ai: player.ai,
      speedBuffUntil: player.speedBuffUntil,
      powerUntil: player.powerUntil,
      downSince: player.downSince,
    };

    return out;
  }

  private toSectorView(sector: SectorState): SectorState {
    return {
      id: sector.id,
      row: sector.row,
      col: sector.col,
      x: sector.x,
      y: sector.y,
      size: sector.size,
      type: sector.type,
      discovered: sector.discovered,
      captured: sector.captured,
      dotCount: sector.dotCount,
      totalDots: sector.totalDots,
    };
  }

  private updateGates(): void {
    for (const gate of this.world.gates) {
      if (gate.permanent) {
        gate.open = true;
        continue;
      }

      const aPressed = this.hasStandingPlayer(gate.switchA.x, gate.switchA.y);
      const bPressed = this.hasStandingPlayer(gate.switchB.x, gate.switchB.y);
      gate.open = aPressed && bPressed;
    }
  }

  private hasStandingPlayer(x: number, y: number): boolean {
    for (const player of this.players.values()) {
      if (player.state !== 'down' && player.x === x && player.y === y) {
        return true;
      }
    }
    return false;
  }

  private updatePowerPellets(nowMs: number): void {
    for (const pellet of this.world.powerPellets.values()) {
      if (pellet.active) {
        continue;
      }
      if (nowMs >= pellet.respawnAt) {
        if (
          !this.isWalkable(pellet.x, pellet.y) ||
          isGateCellOrSwitch(this.world.gates, pellet.x, pellet.y)
        ) {
          pellet.respawnAt = nowMs + 1000;
          continue;
        }
        pellet.active = true;
        this.events.push({ type: 'pellet_respawned', key: pellet.key });
      }
    }
  }

  private updateFruitSpawner(nowMs: number): void {
    if (nowMs - this.lastFruitSpawnMs < 20_000) {
      return;
    }

    const maxFruits = Math.max(2, Math.floor(this.playerCount / 4));
    if (this.fruits.size >= maxFruits) {
      return;
    }

    this.lastFruitSpawnMs = nowMs;

    const cell = this.pickFruitSpawnCell();
    if (!cell) {
      return;
    }

    const fruit: FruitInternal = {
      id: makeId('fruit'),
      type: pickFruitType(this.rng),
      x: cell.x,
      y: cell.y,
      spawnedAt: nowMs,
    };

    this.fruits.set(fruit.id, fruit);
    this.events.push({ type: 'fruit_spawned', fruit: { ...fruit } });
  }

  private pickFruitSpawnCell(): Vec2 | null {
    const sectors = this.world.sectors.filter((sector) => sector.discovered);
    const source = sectors.length > 0 ? this.rng.pick(sectors) : this.rng.pick(this.world.sectors);

    for (let i = 0; i < 40; i += 1) {
      const cell = this.rng.pick(source.floorCells);
      const key = keyOf(cell.x, cell.y);
      const pellet = this.world.powerPellets.get(key);
      if (pellet?.active) {
        continue;
      }
      if (this.world.dots.has(key)) {
        continue;
      }
      const occupiedByPlayer = Array.from(this.players.values()).some((player) => player.x === cell.x && player.y === cell.y);
      const occupiedByGhost = Array.from(this.ghosts.values()).some((ghost) => ghost.x === cell.x && ghost.y === cell.y);
      if (occupiedByPlayer || occupiedByGhost) {
        continue;
      }
      return cell;
    }

    return null;
  }

  private updatePlayers(dtMs: number, nowMs: number): void {
    const dtSec = dtMs / 1000;

    for (const player of this.players.values()) {
      if (player.state === 'down') {
        if (player.downSince && nowMs - player.downSince >= RESCUE_TIMEOUT_MS) {
          this.autoRespawn(player, nowMs);
        }
        continue;
      }

      if (player.state === 'power' && nowMs >= player.powerUntil) {
        player.state = 'normal';
      }

      if (player.ai) {
        this.updateAiDirection(player, nowMs);
      }

      if (player.awakenRequested) {
        player.awakenRequested = false;
        this.tryAwaken(player, nowMs);
      }

      const speed = this.getPlayerSpeed(player, nowMs);
      player.moveBuffer += speed * dtSec;

      let safety = 0;
      while (player.moveBuffer >= 1 && safety < 8) {
        safety += 1;
        const moved = this.movePlayerSingleStep(player);
        if (!moved) {
          player.moveBuffer = 0;
          break;
        }
        player.moveBuffer -= 1;
        this.handlePlayerCellInteractions(player, nowMs);
      }
    }
  }

  private updateAiDirection(player: PlayerInternal, nowMs: number): void {
    if (nowMs < player.aiThinkAt) {
      return;
    }

    player.aiThinkAt = nowMs + 180;

    const directions = this.availableDirections(player.x, player.y, player.dir);
    if (directions.length === 0) {
      return;
    }

    if (this.shouldAiAwaken(player)) {
      player.awakenRequested = true;
    }

    if (player.holdUntilMs > nowMs) {
      player.desiredDir = 'none';
      player.dir = 'none';
      return;
    }

    if (this.holdGateSwitchIfNeeded(player, nowMs)) {
      return;
    }

    const aiContext = this.buildAiContext();
    const strategicDir = this.chooseStrategicAiDirection(player, aiContext);

    let bestDir = directions[0] as MoveDirection;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const dir of directions) {
      const vec = DIRECTION_VECTORS[dir];
      const nx = player.x + vec.x;
      const ny = player.y + vec.y;
      const score = this.scoreAiCandidate(player, nx, ny, dir, strategicDir, aiContext);
      if (score > bestScore) {
        bestScore = score;
        bestDir = dir;
      }
    }

    player.desiredDir = bestDir;
  }

  private buildAiContext(): { downCells: Set<string>; fruitCells: Set<string> } {
    const downCells = new Set<string>();
    const fruitCells = new Set<string>();

    for (const teammate of this.players.values()) {
      if (teammate.state === 'down') {
        downCells.add(keyOf(teammate.x, teammate.y));
      }
    }

    for (const fruit of this.fruits.values()) {
      fruitCells.add(keyOf(fruit.x, fruit.y));
    }

    return { downCells, fruitCells };
  }

  private shouldAiAwaken(player: PlayerInternal): boolean {
    if (player.state === 'down' || player.state === 'power' || player.stocks <= 0) {
      return false;
    }

    const nearGhost = this.distanceToNearestGhost(player.x, player.y);
    if (nearGhost !== null && nearGhost <= 2) {
      return true;
    }

    const bossDist = this.distanceToNearestGhostType(player.x, player.y, 'boss');
    if (bossDist !== null && bossDist <= 4) {
      return true;
    }

    if (this.captureRatio() >= 0.88 && player.stocks >= 2 && nearGhost !== null && nearGhost <= 4) {
      return true;
    }

    return false;
  }

  private holdGateSwitchIfNeeded(player: PlayerInternal, nowMs: number): boolean {
    for (const gate of this.world.gates) {
      if (gate.open) {
        continue;
      }

      const onA = player.x === gate.switchA.x && player.y === gate.switchA.y;
      const onB = player.x === gate.switchB.x && player.y === gate.switchB.y;
      if (!onA && !onB) {
        continue;
      }

      const otherSwitch = onA ? gate.switchB : gate.switchA;
      const otherPressed = this.hasStandingPlayer(otherSwitch.x, otherSwitch.y);
      if (otherPressed) {
        continue;
      }

      const helperNearby = Array.from(this.players.values()).some((teammate) => {
        if (teammate.id === player.id || teammate.state === 'down') {
          return false;
        }
        return manhattan(teammate.x, teammate.y, otherSwitch.x, otherSwitch.y) <= 12;
      });

      if (helperNearby) {
        player.holdUntilMs = nowMs + 800;
        player.desiredDir = 'none';
        player.dir = 'none';
        return true;
      }
    }

    return false;
  }

  private chooseStrategicAiDirection(
    player: PlayerInternal,
    aiContext: { downCells: Set<string>; fruitCells: Set<string> },
  ): MoveDirection | null {
    const rescueDir = this.findDirectionToPredicate(player.x, player.y, 24, (x, y) =>
      aiContext.downCells.has(keyOf(x, y)),
    );
    if (rescueDir) {
      return rescueDir;
    }

    if (player.state === 'power') {
      const ghostDir = this.findDirectionToPredicate(player.x, player.y, 18, (x, y) => this.hasGhostAt(x, y));
      if (ghostDir) {
        return ghostDir;
      }
    }

    const nearGhost = this.distanceToNearestGhost(player.x, player.y);
    if (player.state !== 'power' && nearGhost !== null && nearGhost <= 3) {
      const pelletDir = this.findDirectionToPredicate(player.x, player.y, 22, (x, y) => {
        const pellet = this.world.powerPellets.get(keyOf(x, y));
        return !!pellet?.active;
      });
      if (pelletDir) {
        return pelletDir;
      }

      const escapeDir = this.pickSafestDirection(player);
      if (escapeDir) {
        return escapeDir;
      }
    }

    const gateAssist = this.findGateAssistDirection(player);
    if (gateAssist) {
      return gateAssist;
    }

    const defenseDir = this.findDirectionToPredicate(player.x, player.y, 26, (x, y) => {
      const sector = this.getSectorAt(x, y);
      if (!sector || !sector.captured) {
        return false;
      }
      const threshold = Math.max(1, Math.floor(sector.totalDots * 0.03));
      return sector.dotCount > threshold;
    });
    if (defenseDir) {
      return defenseDir;
    }

    const exploreDir = this.findDirectionToPredicate(player.x, player.y, 28, (x, y) => {
      const sector = this.getSectorAt(x, y);
      return !!sector && !sector.discovered;
    });
    if (exploreDir) {
      return exploreDir;
    }

    const fruitDir = this.findDirectionToPredicate(player.x, player.y, 20, (x, y) =>
      aiContext.fruitCells.has(keyOf(x, y)),
    );
    if (fruitDir) {
      return fruitDir;
    }

    return this.findDirectionToPredicate(player.x, player.y, 32, (x, y) => this.world.dots.has(keyOf(x, y)));
  }

  private scoreAiCandidate(
    player: PlayerInternal,
    x: number,
    y: number,
    dir: MoveDirection,
    strategicDir: MoveDirection | null,
    aiContext: { downCells: Set<string>; fruitCells: Set<string> },
  ): number {
    let score = 0;
    const key = keyOf(x, y);

    if (this.world.dots.has(key)) {
      score += 12;
      const sector = this.getSectorAt(x, y);
      if (sector && !sector.captured) {
        score += 4;
      }
    }

    const pellet = this.world.powerPellets.get(key);
    if (pellet?.active) {
      score += 24;
    }

    if (aiContext.fruitCells.has(key)) {
      score += 14;
    }

    if (aiContext.downCells.has(key)) {
      score += 45;
    }

    const sector = this.getSectorAt(x, y);
    if (sector) {
      if (!sector.discovered) {
        score += 10;
      }
      if (sector.captured && sector.dotCount > 0) {
        score += 6;
      }
      if (sector.type === 'dark' && player.state !== 'power') {
        score -= 2;
      }
      if (sector.type === 'fast') {
        score += 1;
      }
    }

    const nearGhost = this.distanceToNearestGhost(x, y);
    if (nearGhost !== null) {
      if (player.state === 'power') {
        if (nearGhost <= 1) {
          score += 22;
        } else if (nearGhost <= 3) {
          score += 10;
        } else {
          score -= 1;
        }
      } else {
        if (nearGhost <= 1) {
          score -= 180;
        } else if (nearGhost <= 2) {
          score -= 70;
        } else if (nearGhost <= 3) {
          score -= 25;
        } else {
          score += Math.min(5, nearGhost * 0.6);
        }
      }
    }

    if (strategicDir) {
      score += strategicDir === dir ? 16 : -2;
    }
    if (dir === player.dir) {
      score += 1.5;
    }
    if (this.isOccupiedByOtherStandingPlayer(x, y, player.id)) {
      score -= 6;
    }

    return score;
  }

  private pickSafestDirection(player: PlayerInternal): MoveDirection | null {
    const directions = this.availableDirections(player.x, player.y, player.dir);
    if (directions.length === 0) {
      return null;
    }

    let bestDir = directions[0] as MoveDirection;
    let bestSafety = Number.NEGATIVE_INFINITY;

    for (const dir of directions) {
      const vec = DIRECTION_VECTORS[dir];
      const nx = player.x + vec.x;
      const ny = player.y + vec.y;
      const dist = this.distanceToNearestGhost(nx, ny) ?? 99;
      if (dist > bestSafety) {
        bestSafety = dist;
        bestDir = dir;
      }
    }

    return bestDir;
  }

  private findGateAssistDirection(player: PlayerInternal): MoveDirection | null {
    let best: { dir: MoveDirection; dist: number } | null = null;

    for (const gate of this.world.gates) {
      if (gate.open) {
        continue;
      }

      const aPressed = this.hasStandingPlayer(gate.switchA.x, gate.switchA.y);
      const bPressed = this.hasStandingPlayer(gate.switchB.x, gate.switchB.y);
      let target: Vec2 | null = null;

      if (aPressed && !bPressed) {
        target = gate.switchB;
      } else if (bPressed && !aPressed) {
        target = gate.switchA;
      } else if (!aPressed && !bPressed) {
        const gateDist = Math.min(
          manhattan(player.x, player.y, gate.a.x, gate.a.y),
          manhattan(player.x, player.y, gate.b.x, gate.b.y),
        );
        if (gateDist <= 8) {
          const distA = manhattan(player.x, player.y, gate.switchA.x, gate.switchA.y);
          const distB = manhattan(player.x, player.y, gate.switchB.x, gate.switchB.y);
          target = distA <= distB ? gate.switchA : gate.switchB;
        }
      }

      if (!target) {
        continue;
      }
      if (player.x === target.x && player.y === target.y) {
        continue;
      }

      const dir = this.findDirectionToPredicate(
        player.x,
        player.y,
        22,
        (x, y) => x === target!.x && y === target!.y,
      );
      if (!dir) {
        continue;
      }

      const dist = manhattan(player.x, player.y, target.x, target.y);
      if (!best || dist < best.dist) {
        best = { dir, dist };
      }
    }

    return best?.dir ?? null;
  }

  private findDirectionToPredicate(
    startX: number,
    startY: number,
    maxDepth: number,
    predicate: (x: number, y: number) => boolean,
  ): MoveDirection | null {
    type Node = { x: number; y: number; depth: number; firstDir: MoveDirection | null };
    const queue: Node[] = [{ x: startX, y: startY, depth: 0, firstDir: null }];
    const visited = new Set<string>([keyOf(startX, startY)]);

    for (let index = 0; index < queue.length; index += 1) {
      const node = queue[index] as Node;
      if (node.depth > 0 && predicate(node.x, node.y)) {
        return node.firstDir;
      }

      if (node.depth >= maxDepth) {
        continue;
      }

      for (const dir of this.shuffledMoveDirections()) {
        if (!this.canMove(node.x, node.y, dir)) {
          continue;
        }
        const vec = DIRECTION_VECTORS[dir];
        const nx = node.x + vec.x;
        const ny = node.y + vec.y;
        const key = keyOf(nx, ny);
        if (visited.has(key)) {
          continue;
        }
        visited.add(key);
        queue.push({
          x: nx,
          y: ny,
          depth: node.depth + 1,
          firstDir: node.firstDir ?? dir,
        });
      }
    }

    return null;
  }

  private shuffledMoveDirections(): MoveDirection[] {
    const directions: MoveDirection[] = ['up', 'down', 'left', 'right'];
    for (let i = directions.length - 1; i > 0; i -= 1) {
      const j = this.rng.int(0, i);
      const tmp = directions[i] as MoveDirection;
      directions[i] = directions[j] as MoveDirection;
      directions[j] = tmp;
    }
    return directions;
  }

  private distanceToNearestGhost(x: number, y: number): number | null {
    let nearest = Number.POSITIVE_INFINITY;
    for (const ghost of this.ghosts.values()) {
      nearest = Math.min(nearest, manhattan(x, y, ghost.x, ghost.y));
    }
    return Number.isFinite(nearest) ? nearest : null;
  }

  private distanceToNearestGhostType(x: number, y: number, type: GhostType): number | null {
    let nearest = Number.POSITIVE_INFINITY;
    for (const ghost of this.ghosts.values()) {
      if (ghost.type !== type) {
        continue;
      }
      nearest = Math.min(nearest, manhattan(x, y, ghost.x, ghost.y));
    }
    return Number.isFinite(nearest) ? nearest : null;
  }

  private hasGhostAt(x: number, y: number): boolean {
    for (const ghost of this.ghosts.values()) {
      if (ghost.x === x && ghost.y === y) {
        return true;
      }
    }
    return false;
  }

  private isOccupiedByOtherStandingPlayer(x: number, y: number, playerId: string): boolean {
    for (const player of this.players.values()) {
      if (player.id === playerId || player.state === 'down') {
        continue;
      }
      if (player.x === x && player.y === y) {
        return true;
      }
    }
    return false;
  }

  private tryAwaken(player: PlayerInternal, nowMs: number): void {
    if (player.stocks <= 0 || player.state === 'down') {
      return;
    }

    player.stocks -= 1;
    this.activatePowerAura(player, nowMs, AWAKEN_DURATION_MS);
    this.events.push({ type: 'toast', message: `${player.name} が覚醒を発動` });
  }

  private getPlayerSpeed(player: PlayerInternal, nowMs: number): number {
    let speed = PLAYER_BASE_SPEED;
    const sector = this.getSectorAt(player.x, player.y);
    if (sector?.captured) {
      speed *= PLAYER_CAPTURED_SPEED_MULTIPLIER;
    }
    if (nowMs < player.speedBuffUntil) {
      speed *= 1.3;
    }
    return speed;
  }

  private movePlayerSingleStep(player: PlayerInternal): boolean {
    const desiredDir = player.desiredDir;
    if (desiredDir !== 'none' && this.canMove(player.x, player.y, desiredDir)) {
      player.dir = desiredDir;
    }

    if (player.dir === 'none') {
      return false;
    }

    if (!this.canMove(player.x, player.y, player.dir)) {
      return false;
    }

    const vec = DIRECTION_VECTORS[player.dir];
    player.x += vec.x;
    player.y += vec.y;
    return true;
  }

  private canMove(x: number, y: number, dir: Direction): boolean {
    if (dir === 'none') {
      return false;
    }

    const vec = DIRECTION_VECTORS[dir];
    const nx = x + vec.x;
    const ny = y + vec.y;

    if (!this.isWalkable(nx, ny)) {
      return false;
    }

    for (const gate of this.world.gates) {
      if (gate.open) {
        continue;
      }
      const crossingForward = gate.a.x === x && gate.a.y === y && gate.b.x === nx && gate.b.y === ny;
      const crossingBackward = gate.b.x === x && gate.b.y === y && gate.a.x === nx && gate.a.y === ny;
      if (crossingForward || crossingBackward) {
        return false;
      }
    }

    return true;
  }

  private isWalkable(x: number, y: number): boolean {
    if (x < 0 || y < 0 || y >= this.world.height || x >= this.world.width) {
      return false;
    }
    return this.world.tiles[y][x] === '.';
  }

  private availableDirections(x: number, y: number, dir: Direction): MoveDirection[] {
    const values: MoveDirection[] = [];
    const all: MoveDirection[] = ['up', 'down', 'left', 'right'];
    for (const candidate of all) {
      if (!this.canMove(x, y, candidate)) {
        continue;
      }
      values.push(candidate);
    }

    if (values.length <= 1) {
      return values;
    }

    const opposite = oppositeOf(dir);
    if (opposite && values.includes(opposite)) {
      return values.filter((candidate) => candidate !== opposite);
    }

    return values;
  }

  private handlePlayerCellInteractions(player: PlayerInternal, nowMs: number): void {
    const sector = this.getSectorAt(player.x, player.y);
    if (sector && !sector.discovered) {
      sector.discovered = true;
      this.events.push({ type: 'toast', message: `新エリア発見: #${sector.id}` });
      this.timeline.push({ atMs: this.elapsedMs, label: `エリア${sector.id}初探索` });
    }

    for (const teammate of this.players.values()) {
      if (teammate.id === player.id || teammate.state !== 'down') {
        continue;
      }
      if (teammate.x === player.x && teammate.y === player.y) {
        this.revive(teammate, player, nowMs, false);
      }
    }

    const dotKey = keyOf(player.x, player.y);
    if (this.world.dots.delete(dotKey)) {
      player.score += 10;
      player.stats.dots += 1;
      this.events.push({ type: 'dot_eaten', x: player.x, y: player.y, by: player.id });
      if (sector) {
        sector.dotCount = Math.max(0, sector.dotCount - 1);
      }

      if (player.stocks < MAX_AWAKEN_STOCK) {
        player.gauge += 1;
        if (player.gauge >= DOTS_FOR_AWAKEN) {
          player.stocks += 1;
          player.gauge = 0;
        }
      } else {
        player.gauge = DOTS_FOR_AWAKEN;
      }
    }

    const pellet = this.world.powerPellets.get(dotKey);
    if (pellet && pellet.active) {
      pellet.active = false;
      pellet.respawnAt = nowMs + POWER_PELLET_RESPAWN_MS;
      this.activatePowerAura(player, nowMs, POWER_DURATION_MS);
      this.events.push({ type: 'pellet_taken', key: pellet.key });
    }

    const fruit = this.findFruitAt(player.x, player.y);
    if (fruit) {
      this.takeFruit(player, fruit, nowMs);
    }
  }

  private activatePowerAura(source: PlayerInternal, nowMs: number, durationMs: number): void {
    const radius = POWER_AURA_RADIUS * source.nextAuraMultiplier;
    source.nextAuraMultiplier = 1;

    for (const player of this.players.values()) {
      if (player.state === 'down') {
        continue;
      }
      const dist = manhattan(player.x, player.y, source.x, source.y);
      if (dist <= radius) {
        player.state = 'power';
        player.powerUntil = Math.max(player.powerUntil, nowMs + durationMs);
      }
    }
  }

  private findFruitAt(x: number, y: number): FruitInternal | null {
    for (const fruit of this.fruits.values()) {
      if (fruit.x === x && fruit.y === y) {
        return fruit;
      }
    }
    return null;
  }

  private takeFruit(player: PlayerInternal, fruit: FruitInternal, nowMs: number): void {
    this.fruits.delete(fruit.id);

    if (fruit.type === 'cherry') {
      player.speedBuffUntil = nowMs + 10_000;
    } else if (fruit.type === 'strawberry') {
      player.nextAuraMultiplier = 2;
    } else if (fruit.type === 'orange') {
      for (const ghost of this.ghosts.values()) {
        const dist = manhattan(player.x, player.y, ghost.x, ghost.y);
        if (dist <= 6) {
          ghost.stunnedUntil = nowMs + 5000;
        }
      }
    } else if (fruit.type === 'apple') {
      for (const teammate of this.players.values()) {
        if (teammate.state === 'down') {
          this.revive(teammate, player, nowMs, true);
        }
      }
    } else if (fruit.type === 'key') {
      const nearestGate = this.findNearestClosedGate(player.x, player.y);
      if (nearestGate) {
        nearestGate.permanent = true;
        nearestGate.open = true;
      }
    } else if (fruit.type === 'grape') {
      if (player.stocks < MAX_AWAKEN_STOCK) {
        player.stocks += 1;
      } else {
        player.gauge = DOTS_FOR_AWAKEN;
      }
    }

    this.events.push({ type: 'fruit_taken', fruitId: fruit.id, by: player.id, fruitType: fruit.type });
  }

  private findNearestClosedGate(x: number, y: number) {
    let bestDist = Number.POSITIVE_INFINITY;
    let best: (typeof this.world.gates)[number] | null = null;

    for (const gate of this.world.gates) {
      if (gate.permanent) {
        continue;
      }
      const dist = Math.min(manhattan(x, y, gate.a.x, gate.a.y), manhattan(x, y, gate.b.x, gate.b.y));
      if (dist < bestDist) {
        bestDist = dist;
        best = gate;
      }
    }

    return best;
  }

  private updateGhosts(dtMs: number, nowMs: number): void {
    const dtSec = dtMs / 1000;

    for (const ghost of this.ghosts.values()) {
      if (nowMs < ghost.stunnedUntil) {
        continue;
      }

      const speed = this.getGhostSpeed(ghost);
      ghost.moveBuffer += speed * dtSec;

      let safety = 0;
      while (ghost.moveBuffer >= 1 && safety < 8) {
        safety += 1;

        const dir = this.chooseGhostDirection(ghost);
        ghost.dir = dir;

        if (dir === 'none') {
          ghost.moveBuffer = 0;
          break;
        }

        const vec = DIRECTION_VECTORS[dir];
        const nx = ghost.x + vec.x;
        const ny = ghost.y + vec.y;
        if (!this.canMove(ghost.x, ghost.y, dir)) {
          ghost.moveBuffer = 0;
          break;
        }

        ghost.x = nx;
        ghost.y = ny;
        ghost.moveBuffer -= 1;
      }
    }
  }

  private getGhostSpeed(ghost: GhostInternal): number {
    let multiplier = this.difficultyMultiplier.ghostSpeed;

    if (this.playerCount <= 5) {
      multiplier *= 0.9;
    } else if (this.playerCount >= 31) {
      multiplier *= 1.06;
    }

    if (ghost.type === 'random') {
      multiplier *= 0.95;
    } else if (ghost.type === 'pincer') {
      multiplier *= 1.1;
    } else if (ghost.type === 'invader') {
      multiplier *= 1.16;
    } else if (ghost.type === 'boss') {
      multiplier *= 0.9;
    }

    const sector = this.getSectorAt(ghost.x, ghost.y);
    if (sector?.type === 'fast') {
      multiplier *= 1.2;
    }

    return GHOST_BASE_SPEED * multiplier;
  }

  private chooseGhostDirection(ghost: GhostInternal): Direction {
    const dirs = this.availableDirections(ghost.x, ghost.y, ghost.dir);
    if (dirs.length === 0) {
      return 'none';
    }

    if (ghost.type === 'random' || ghost.type === 'patrol') {
      return this.rng.pick(dirs);
    }

    const target = this.findGhostTarget(ghost);
    if (!target) {
      return this.rng.pick(dirs);
    }

    let bestDir = dirs[0] as MoveDirection;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const dir of dirs) {
      const vec = DIRECTION_VECTORS[dir];
      const nx = ghost.x + vec.x;
      const ny = ghost.y + vec.y;
      const dist = manhattan(nx, ny, target.x, target.y);
      if (dist < bestScore) {
        bestScore = dist;
        bestDir = dir;
      }
    }

    return bestDir;
  }

  private findGhostTarget(ghost: GhostInternal): Vec2 | null {
    const alivePlayers = Array.from(this.players.values()).filter((player) => player.state !== 'down');
    if (alivePlayers.length === 0) {
      return null;
    }

    if (ghost.type === 'invader') {
      const captured = this.world.sectors.filter((sector) => sector.captured);
      if (captured.length > 0) {
        const sector = this.rng.pick(captured);
        return { x: sector.x + Math.floor(sector.size / 2), y: sector.y + Math.floor(sector.size / 2) };
      }
    }

    let nearest = alivePlayers[0] as PlayerInternal;
    let nearestDist = Number.POSITIVE_INFINITY;

    for (const player of alivePlayers) {
      const baseDist = manhattan(ghost.x, ghost.y, player.x, player.y);
      if (baseDist < nearestDist) {
        nearestDist = baseDist;
        nearest = player;
      }
    }

    if (ghost.type === 'pincer') {
      const vec = nearest.dir === 'none' ? { x: 0, y: 0 } : DIRECTION_VECTORS[nearest.dir];
      return {
        x: clamp(nearest.x + vec.x * 2, 0, this.world.width - 1),
        y: clamp(nearest.y + vec.y * 2, 0, this.world.height - 1),
      };
    }

    return { x: nearest.x, y: nearest.y };
  }

  private resolveGhostCollisions(
    nowMs: number,
    playerPositionsBeforeMove: Map<string, Vec2>,
    ghostPositionsBeforeMove: Map<string, Vec2>,
  ): void {
    for (const player of this.players.values()) {
      if (player.state === 'down') {
        continue;
      }

      for (const ghost of this.ghosts.values()) {
        if (!this.isGhostCollision(player, ghost, playerPositionsBeforeMove, ghostPositionsBeforeMove)) {
          continue;
        }

        if (player.remoteReviveGraceUntil > nowMs) {
          continue;
        }

        if (player.state === 'power') {
          if (ghost.type === 'boss') {
            ghost.hp -= 1;
            player.state = 'normal';
            player.powerUntil = 0;
            this.events.push({ type: 'boss_hit', ghostId: ghost.id, hp: ghost.hp, by: player.id });
            if (ghost.hp <= 0) {
              this.ghosts.delete(ghost.id);
              player.score += 500;
              player.stats.ghosts += 1;
              this.timeline.push({ atMs: this.elapsedMs, label: 'ボス撃破' });
            }
          } else {
            this.respawnGhost(ghost);
            player.score += 100;
            player.stats.ghosts += 1;
          }
          continue;
        }

        this.downPlayer(player, nowMs);
      }
    }
  }

  private isGhostCollision(
    player: PlayerInternal,
    ghost: GhostInternal,
    playerPositionsBeforeMove?: Map<string, Vec2>,
    ghostPositionsBeforeMove?: Map<string, Vec2>,
  ): boolean {
    if (ghost.x === player.x && ghost.y === player.y) {
      return true;
    }

    if (!playerPositionsBeforeMove || !ghostPositionsBeforeMove) {
      return false;
    }

    const playerBefore = playerPositionsBeforeMove.get(player.id);
    const ghostBefore = ghostPositionsBeforeMove.get(ghost.id);
    if (!playerBefore || !ghostBefore) {
      return false;
    }

    const swapped =
      playerBefore.x === ghost.x &&
      playerBefore.y === ghost.y &&
      ghostBefore.x === player.x &&
      ghostBefore.y === player.y;
    return swapped;
  }

  private downPlayer(player: PlayerInternal, nowMs: number): void {
    if (player.state === 'down') {
      return;
    }
    player.state = 'down';
    player.remoteReviveGraceUntil = 0;
    player.downSince = nowMs;
    player.powerUntil = 0;
    player.moveBuffer = 0;
    this.events.push({ type: 'player_down', playerId: player.id });
  }

  private revive(player: PlayerInternal, by: PlayerInternal, nowMs: number, remote: boolean): void {
    if (player.state !== 'down') {
      return;
    }
    player.state = 'normal';
    player.downSince = null;
    player.powerUntil = 0;
    player.remoteReviveGraceUntil = remote ? nowMs + 3_000 : 0;
    by.stats.rescues += 1;
    by.score += 200 + player.stocks * 50;
    this.events.push({ type: 'player_revived', playerId: player.id, by: by.id, auto: false });
  }

  private autoRespawn(player: PlayerInternal, nowMs: number): void {
    if (player.state !== 'down') {
      return;
    }

    const spawn = this.pickRespawnPoint(player);
    player.x = spawn.x;
    player.y = spawn.y;
    player.state = 'normal';
    player.downSince = null;
    player.powerUntil = 0;
    player.remoteReviveGraceUntil = nowMs + AUTO_RESPAWN_GRACE_MS;
    player.gauge = 0;
    player.stocks = Math.max(0, player.stocks - 1);
    this.events.push({ type: 'player_revived', playerId: player.id, by: player.id, auto: true });

    if (player.ai) {
      player.desiredDir = this.rng.pick(['up', 'down', 'left', 'right']);
    }
  }

  private pickRespawnPoint(player: PlayerInternal): Vec2 {
    const capturedSectors = this.world.sectors.filter((sector) => sector.captured);
    if (capturedSectors.length > 0) {
      let bestSector = capturedSectors[0] as (typeof capturedSectors)[number];
      let bestDist = Number.POSITIVE_INFINITY;
      for (const sector of capturedSectors) {
        const sx = sector.x + Math.floor(sector.size / 2);
        const sy = sector.y + Math.floor(sector.size / 2);
        const dist = manhattan(player.x, player.y, sx, sy);
        if (dist < bestDist) {
          bestDist = dist;
          bestSector = sector;
        }
      }

      const safeInBestSector = bestSector.floorCells.filter((cell) => this.isSafeRespawnCell(cell, player.id));
      if (safeInBestSector.length > 0) {
        return this.rng.pick(safeInBestSector);
      }

      const safeInCaptured = capturedSectors
        .flatMap((sector) => sector.floorCells)
        .filter((cell) => this.isSafeRespawnCell(cell, player.id));
      if (safeInCaptured.length > 0) {
        return this.rng.pick(safeInCaptured);
      }
    }

    if (this.isSafeRespawnCell(player.spawn, player.id)) {
      return player.spawn;
    }

    const safeFallback = this.world.playerSpawnCells.filter((cell) => this.isSafeRespawnCell(cell, player.id));
    if (safeFallback.length > 0) {
      return this.rng.pick(safeFallback);
    }

    return player.spawn;
  }

  private isSafeRespawnCell(cell: Vec2, playerId: string): boolean {
    if (this.hasGhostAt(cell.x, cell.y)) {
      return false;
    }
    if (this.isOccupiedByOtherStandingPlayer(cell.x, cell.y, playerId)) {
      return false;
    }
    if (isGateCellOrSwitch(this.world.gates, cell.x, cell.y)) {
      return false;
    }
    const nearestGhost = this.distanceToNearestGhost(cell.x, cell.y);
    if (nearestGhost !== null && nearestGhost <= 2) {
      return false;
    }
    return true;
  }

  private updateSectorControl(dtMs: number, nowMs: number): void {
    for (const sector of this.world.sectors) {
      if (!sector.captured && sector.dotCount === 0) {
        this.captureSector(sector, nowMs);
      }
    }

    const captureRatio = this.captureRatio();
    this.maxCaptureRatio = Math.max(this.maxCaptureRatio, captureRatio);

    const pressure = getCapturePressure(captureRatio);
    const dtSec = dtMs / 1000;

    for (const sector of this.world.sectors) {
      if (!sector.captured) {
        sector.regenAccumulator = 0;
        continue;
      }

      if (nowMs - sector.capturedAt < pressure.graceMs) {
        continue;
      }

      const invaders = this.countGhostBySectorAndType(sector.id, 'invader');
      const invaderBoost = invaders > 0 ? 1 + invaders * 0.4 : 1;
      const regenRate = 0.33 * pressure.regenMultiplier * this.difficultyMultiplier.maintenance * invaderBoost;
      sector.regenAccumulator += regenRate * dtSec;

      while (sector.regenAccumulator >= 1) {
        const added = this.respawnDotInSector(sector);
        if (!added) {
          sector.regenAccumulator = 0;
          break;
        }
        sector.regenAccumulator -= 1;
      }

      const threshold = Math.max(1, Math.floor(sector.totalDots * 0.05));
      if (sector.dotCount > threshold) {
        sector.captured = false;
        sector.regenAccumulator = 0;
        this.events.push({ type: 'sector_lost', sectorId: sector.id });
      }
    }
  }

  private captureSector(sector: (typeof this.world.sectors)[number], nowMs: number): void {
    sector.captured = true;
    sector.capturedAt = nowMs;
    sector.regenAccumulator = 0;

    this.events.push({ type: 'sector_captured', sectorId: sector.id });
    this.timeline.push({ atMs: this.elapsedMs, label: `エリア${sector.id}制覇` });

    for (const player of this.players.values()) {
      if (this.getSectorId(player.x, player.y) === sector.id && player.state !== 'down') {
        player.score += 300;
        player.stats.captures += 1;
      }
    }

    for (const ghost of this.ghosts.values()) {
      if (this.getSectorId(ghost.x, ghost.y) === sector.id) {
        this.respawnGhost(ghost);
      }
    }
  }

  private respawnDotInSector(sector: (typeof this.world.sectors)[number]): boolean {
    if (sector.respawnCandidates.length === 0) {
      return false;
    }

    for (let i = 0; i < 30; i += 1) {
      const cell = this.rng.pick(sector.respawnCandidates);
      const key = keyOf(cell.x, cell.y);
      if (!this.isValidDotRespawnCell(sector.id, cell.x, cell.y)) {
        continue;
      }
      this.world.dots.add(key);
      sector.dotCount += 1;
      this.events.push({ type: 'dot_respawned', x: cell.x, y: cell.y });
      return true;
    }

    for (const cell of sector.respawnCandidates) {
      if (!this.isValidDotRespawnCell(sector.id, cell.x, cell.y)) {
        continue;
      }
      this.world.dots.add(keyOf(cell.x, cell.y));
      sector.dotCount += 1;
      this.events.push({ type: 'dot_respawned', x: cell.x, y: cell.y });
      return true;
    }

    return false;
  }

  private isValidDotRespawnCell(sectorId: number, x: number, y: number): boolean {
    if (!this.isWalkable(x, y)) {
      return false;
    }
    if (this.getSectorId(x, y) !== sectorId) {
      return false;
    }

    const key = keyOf(x, y);
    if (this.world.dots.has(key)) {
      return false;
    }
    if (this.world.powerPellets.has(key)) {
      return false;
    }
    if (isGateCellOrSwitch(this.world.gates, x, y)) {
      return false;
    }

    return true;
  }

  private countGhostBySectorAndType(sectorId: number, type: GhostType): number {
    let count = 0;
    for (const ghost of this.ghosts.values()) {
      if (ghost.type === type && this.getSectorId(ghost.x, ghost.y) === sectorId) {
        count += 1;
      }
    }
    return count;
  }

  private adjustGhostPopulation(nowMs: number): void {
    const ratio = this.captureRatio();
    const activePlayers = Array.from(this.players.values()).filter((player) => player.state !== 'down').length;
    const target = clamp(
      Math.round(Math.max(this.maxGhosts * 0.5, activePlayers * (1 + ratio * 0.7))),
      4,
      this.maxGhosts,
    );

    if (this.ghosts.size < target) {
      const add = Math.min(3, target - this.ghosts.size);
      for (let i = 0; i < add; i += 1) {
        this.spawnGhost(pickGhostType(ratio, this.rng));
      }
    } else if (this.ghosts.size > target + 4) {
      let remove = this.ghosts.size - target;
      for (const [id, ghost] of this.ghosts.entries()) {
        if (remove <= 0) {
          break;
        }
        if (ghost.type === 'boss') {
          continue;
        }
        this.ghosts.delete(id);
        remove -= 1;
      }
    }

    const hasBoss = Array.from(this.ghosts.values()).some((ghost) => ghost.type === 'boss');
    if (ratio >= 0.9 && !hasBoss) {
      const boss = this.spawnGhost('boss');
      boss.hp = 3;
      this.events.push({ type: 'boss_spawned', ghostId: boss.id });
      this.timeline.push({ atMs: this.elapsedMs, label: 'ボス出現' });
    }

    // 侵攻圧が続くと侵攻ゴーストを増やす
    if (ratio >= 0.7) {
      const invaders = Array.from(this.ghosts.values()).filter((ghost) => ghost.type === 'invader').length;
      if (invaders < Math.max(2, Math.floor(this.playerCount / 8))) {
        this.spawnGhost('invader');
      }
    }

    // 長時間プレイでフルーツが残り続けるのを防ぐ
    for (const [id, fruit] of this.fruits.entries()) {
      if (nowMs - fruit.spawnedAt > 35_000) {
        this.fruits.delete(id);
      }
    }
  }

  private spawnInitialGhosts(): void {
    const count = Math.max(4, Math.floor(this.maxGhosts * 0.75));
    for (let i = 0; i < count; i += 1) {
      this.spawnGhost(pickGhostType(0, this.rng));
    }
  }

  private spawnGhost(type: GhostType): GhostInternal {
    const spawn = this.rng.pick(this.world.ghostSpawnCells);
    let x = spawn.x;
    let y = spawn.y;

    for (let i = 0; i < 10; i += 1) {
      const dx = this.rng.int(-2, 2);
      const dy = this.rng.int(-2, 2);
      const tx = clamp(spawn.x + dx, 1, this.world.width - 2);
      const ty = clamp(spawn.y + dy, 1, this.world.height - 2);
      if (this.isWalkable(tx, ty)) {
        x = tx;
        y = ty;
        break;
      }
    }

    const ghost: GhostInternal = {
      id: makeId('ghost'),
      x,
      y,
      dir: this.rng.pick(['up', 'down', 'left', 'right']),
      type,
      hp: type === 'boss' ? 3 : 1,
      stunnedUntil: 0,
      moveBuffer: 0,
    };

    this.ghosts.set(ghost.id, ghost);
    return ghost;
  }

  private respawnGhost(ghost: GhostInternal): void {
    const spawn = this.rng.pick(this.world.ghostSpawnCells);
    ghost.x = spawn.x;
    ghost.y = spawn.y;
    ghost.dir = this.rng.pick(['up', 'down', 'left', 'right']);
    ghost.moveBuffer = 0;
    ghost.hp = ghost.type === 'boss' ? 3 : 1;
    ghost.stunnedUntil = 0;
  }

  private recordMilestones(): void {
    const ratio = Math.round(this.captureRatio() * 100);
    const milestones = [25, 50, 75, 90];
    for (const milestone of milestones) {
      if (ratio >= milestone && !this.milestoneEmitted.has(milestone)) {
        this.milestoneEmitted.add(milestone);
        this.timeline.push({ atMs: this.elapsedMs, label: `制覇率${milestone}%到達` });
      }
    }
  }

  private checkGameOver(nowMs: number): void {
    const ratio = this.captureRatio();
    const allCaptured = this.world.sectors.every((sector) => sector.captured);
    if (allCaptured) {
      this.finish('victory', '全エリア同時制覇');
      return;
    }

    if (this.elapsedMs >= this.config.timeLimitMs) {
      this.finish('timeout', '時間切れ');
      return;
    }

    const allDown = Array.from(this.players.values()).every((player) => player.state === 'down');
    if (allDown) {
      this.finish('all_down', '全滅');
      return;
    }

    if (this.maxCaptureRatio >= 0.7 && ratio <= 0.3) {
      this.finish('collapse', '制覇率崩壊');
      return;
    }

    // 低頻度の警告ログ
    if (this.tickCounter % TICK_RATE === 0) {
      const activeCount = Array.from(this.players.values()).filter((player) => player.state !== 'down').length;
      if (activeCount <= 3 && this.players.size > 3) {
        this.timeline.push({ atMs: this.elapsedMs, label: '全滅危機' });
      }
    }

    // use nowMs in this function to satisfy explicit flow readability
    void nowMs;
  }

  private finish(reason: GameOverReason, label: string): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.endReason = reason;
    this.timeline.push({ atMs: this.elapsedMs, label });
  }

  private captureRatio(): number {
    const captured = this.world.sectors.filter((sector) => sector.captured).length;
    return captured / this.world.sectors.length;
  }

  private getSectorId(x: number, y: number): number {
    const col = clamp(Math.floor(x / this.world.sectorSize), 0, this.world.side - 1);
    const row = clamp(Math.floor(y / this.world.sectorSize), 0, this.world.side - 1);
    return row * this.world.side + col;
  }

  private getSectorAt(x: number, y: number) {
    return this.world.sectors[this.getSectorId(x, y)] ?? null;
  }

  private capturePlayerPositions(): Map<string, Vec2> {
    const positions = new Map<string, Vec2>();
    for (const player of this.players.values()) {
      positions.set(player.id, { x: player.x, y: player.y });
    }
    return positions;
  }

  private captureGhostPositions(): Map<string, Vec2> {
    const positions = new Map<string, Vec2>();
    for (const ghost of this.ghosts.values()) {
      positions.set(ghost.id, { x: ghost.x, y: ghost.y });
    }
    return positions;
  }
}
