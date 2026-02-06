import type {
  FruitView,
  GhostView,
  PlayerView,
  Snapshot,
  WorldInit,
} from '../shared/types.js';
import {
  clampNumber,
  fruitColor,
  ghostColor,
  resolveFocusPlayer,
} from './state.js';
import type {
  ClientState,
  InterpolationState,
} from './state.js';

export class CanvasRenderer {
  private readonly ctx: CanvasRenderingContext2D;

  public constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = mustCanvasContext(canvas);
  }

  public resize(): void {
    const hudWidth = window.innerWidth > 1080 ? 330 : 0;
    this.canvas.width = window.innerWidth - hudWidth;
    this.canvas.height = window.innerHeight;
  }

  public updateInterpolationStates(state: ClientState, nextSnapshot: Snapshot): void {
    const nowMs = performance.now();
    state.latestSnapshotReceivedAtMs = nowMs;

    this.updateEntityInterpolationMap(
      state.playerInterpolation,
      nextSnapshot.players.map((player) => ({ id: player.id, x: player.x, y: player.y })),
      nowMs,
      3,
    );
    this.updateEntityInterpolationMap(
      state.ghostInterpolation,
      nextSnapshot.ghosts.map((ghost) => ({ id: ghost.id, x: ghost.x, y: ghost.y })),
      nowMs,
      4,
    );
  }

  public render(state: ClientState): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = '#07090f';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (!state.world || !state.snapshot) {
      this.drawCenteredText('サーバー接続中...', '#f5f7ff');
      return;
    }

    const world = state.world;
    const snapshot = state.snapshot;
    const camera = this.resolveCameraCenter(world, snapshot, state);
    const centerX = camera.x;
    const centerY = camera.y;
    const interpolationAlpha = this.getInterpolationAlpha(state);

    const tileSize = Math.max(12, Math.min(30, Math.floor(Math.min(this.canvas.width, this.canvas.height) / 26)));
    const originX = Math.floor(this.canvas.width / 2 - centerX * tileSize);
    const originY = Math.floor(this.canvas.height / 2 - centerY * tileSize);

    const visibleCols = Math.ceil(this.canvas.width / tileSize) + 4;
    const visibleRows = Math.ceil(this.canvas.height / tileSize) + 4;
    const minX = Math.max(0, Math.floor(centerX - visibleCols / 2));
    const minY = Math.max(0, Math.floor(centerY - visibleRows / 2));
    const maxX = Math.min(world.width - 1, Math.ceil(centerX + visibleCols / 2));
    const maxY = Math.min(world.height - 1, Math.ceil(centerY + visibleRows / 2));

    for (let y = minY; y <= maxY; y += 1) {
      const row = world.tiles[y] as string | undefined;
      if (!row) {
        continue;
      }
      for (let x = minX; x <= maxX; x += 1) {
        const sx = originX + x * tileSize;
        const sy = originY + y * tileSize;
        const sector = this.sectorAt(world, snapshot, x, y);
        const discovered = !!sector?.discovered;

        if (row[x] === '#') {
          this.ctx.fillStyle = discovered ? '#2d4a8a' : '#0d0f17';
          this.ctx.fillRect(sx, sy, tileSize, tileSize);
        } else {
          if (!discovered) {
            this.ctx.fillStyle = '#090b12';
            this.ctx.fillRect(sx, sy, tileSize, tileSize);
            continue;
          }

          if (sector?.captured) {
            this.ctx.fillStyle = '#113044';
          } else if (sector?.type === 'dark') {
            this.ctx.fillStyle = '#131417';
          } else {
            this.ctx.fillStyle = '#0d1322';
          }
          this.ctx.fillRect(sx, sy, tileSize, tileSize);
        }
      }
    }

    for (const key of state.dotSet) {
      const [x, y] = key.split(',').map(Number);
      if (x < minX || x > maxX || y < minY || y > maxY) {
        continue;
      }
      const row = world.tiles[y] as string | undefined;
      if (!row || row[x] !== '.') {
        continue;
      }
      const sector = this.sectorAt(world, snapshot, x, y);
      if (!sector?.discovered) {
        continue;
      }
      const sx = originX + x * tileSize + tileSize / 2;
      const sy = originY + y * tileSize + tileSize / 2;
      this.circle(sx, sy, Math.max(1.5, tileSize * 0.1), '#ffd66a');
    }

    for (const pellet of state.pelletMap.values()) {
      if (!pellet.active) {
        continue;
      }
      if (pellet.x < minX || pellet.x > maxX || pellet.y < minY || pellet.y > maxY) {
        continue;
      }
      const row = world.tiles[pellet.y] as string | undefined;
      if (!row || row[pellet.x] !== '.') {
        continue;
      }
      const sector = this.sectorAt(world, snapshot, pellet.x, pellet.y);
      if (!sector?.discovered) {
        continue;
      }
      const sx = originX + pellet.x * tileSize + tileSize / 2;
      const sy = originY + pellet.y * tileSize + tileSize / 2;
      this.circle(sx, sy, Math.max(3, tileSize * 0.22), '#7af0ff');
    }

    this.drawGates(world, snapshot, originX, originY, tileSize, minX, minY, maxX, maxY);
    this.drawFruits(snapshot.fruits, world, snapshot, originX, originY, tileSize, minX, minY, maxX, maxY);
    this.drawGhosts(
      snapshot.ghosts,
      world,
      snapshot,
      originX,
      originY,
      tileSize,
      minX,
      minY,
      maxX,
      maxY,
      state.ghostInterpolation,
      interpolationAlpha,
    );
    this.drawPlayers(
      snapshot.players,
      world,
      snapshot,
      originX,
      originY,
      tileSize,
      minX,
      minY,
      maxX,
      maxY,
      snapshot.nowMs,
      state.playerInterpolation,
      interpolationAlpha,
      state.meId,
    );
  }

  private resolveCameraCenter(worldState: WorldInit, stateSnapshot: Snapshot, state: ClientState): { x: number; y: number } {
    const focus = resolveFocusPlayer(state);
    if (!focus) {
      return { x: worldState.width / 2, y: worldState.height / 2 };
    }

    const sector = this.sectorAt(worldState, stateSnapshot, focus.x, focus.y);
    if (!sector) {
      return { x: focus.x + 0.5, y: focus.y + 0.5 };
    }

    return {
      x: sector.x + sector.size / 2,
      y: sector.y + sector.size / 2,
    };
  }

  private drawGates(
    worldState: WorldInit,
    state: Snapshot,
    originX: number,
    originY: number,
    tileSize: number,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): void {
    for (const gate of state.gates) {
      for (const p of [gate.a, gate.b]) {
        if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) {
          continue;
        }
        const sector = this.sectorAt(worldState, state, p.x, p.y);
        if (!sector?.discovered) {
          continue;
        }

        const sx = originX + p.x * tileSize;
        const sy = originY + p.y * tileSize;
        this.ctx.fillStyle = gate.open ? 'rgba(92, 211, 130, 0.7)' : 'rgba(255, 110, 110, 0.8)';
        this.ctx.fillRect(sx + 2, sy + 2, tileSize - 4, tileSize - 4);
      }

      for (const sw of [gate.switchA, gate.switchB]) {
        if (sw.x < minX || sw.x > maxX || sw.y < minY || sw.y > maxY) {
          continue;
        }
        const sx = originX + sw.x * tileSize + tileSize / 2;
        const sy = originY + sw.y * tileSize + tileSize / 2;
        this.circle(sx, sy, Math.max(3, tileSize * 0.16), '#ffcb6b');
      }
    }
  }

  private drawFruits(
    fruits: FruitView[],
    worldState: WorldInit,
    state: Snapshot,
    originX: number,
    originY: number,
    tileSize: number,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): void {
    for (const fruit of fruits) {
      if (fruit.x < minX || fruit.x > maxX || fruit.y < minY || fruit.y > maxY) {
        continue;
      }
      const sector = this.sectorAt(worldState, state, fruit.x, fruit.y);
      if (!sector?.discovered) {
        continue;
      }
      const sx = originX + fruit.x * tileSize + tileSize / 2;
      const sy = originY + fruit.y * tileSize + tileSize / 2;
      this.circle(sx, sy, Math.max(3, tileSize * 0.24), fruitColor(fruit.type));
    }
  }

  private drawGhosts(
    ghosts: GhostView[],
    worldState: WorldInit,
    state: Snapshot,
    originX: number,
    originY: number,
    tileSize: number,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    interpolationMap: Map<string, InterpolationState>,
    interpolationAlpha: number,
  ): void {
    for (const ghost of ghosts) {
      const renderPos = this.getInterpolatedPosition(ghost.id, ghost.x, ghost.y, interpolationMap, interpolationAlpha);
      if (renderPos.x < minX || renderPos.x > maxX || renderPos.y < minY || renderPos.y > maxY) {
        continue;
      }
      const sector = this.sectorAt(worldState, state, Math.floor(renderPos.x), Math.floor(renderPos.y));
      if (!sector?.discovered) {
        continue;
      }

      const sx = originX + renderPos.x * tileSize + tileSize / 2;
      const sy = originY + renderPos.y * tileSize + tileSize / 2;
      this.circle(sx, sy, Math.max(4, tileSize * 0.34), ghostColor(ghost.type));

      if (ghost.type === 'boss') {
        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = `${Math.max(10, Math.floor(tileSize * 0.4))}px monospace`;
        this.ctx.fillText(`${ghost.hp}`, sx - tileSize * 0.1, sy - tileSize * 0.45);
      }
    }
  }

  private drawPlayers(
    players: PlayerView[],
    worldState: WorldInit,
    state: Snapshot,
    originX: number,
    originY: number,
    tileSize: number,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    nowMs: number,
    interpolationMap: Map<string, InterpolationState>,
    interpolationAlpha: number,
    meId: string,
  ): void {
    for (const player of players) {
      const renderPos = this.getInterpolatedPosition(player.id, player.x, player.y, interpolationMap, interpolationAlpha);
      if (renderPos.x < minX || renderPos.x > maxX || renderPos.y < minY || renderPos.y > maxY) {
        continue;
      }
      const sector = this.sectorAt(worldState, state, Math.floor(renderPos.x), Math.floor(renderPos.y));
      if (!sector?.discovered) {
        continue;
      }

      const sx = originX + renderPos.x * tileSize + tileSize / 2;
      const sy = originY + renderPos.y * tileSize + tileSize / 2;
      const base = player.id === meId ? '#ffef8f' : '#f5b264';
      const color = player.state === 'down' ? 'rgba(189, 68, 68, 0.55)' : base;
      this.circle(sx, sy, Math.max(4, tileSize * 0.36), color);

      if (player.state === 'power') {
        this.drawPowerEffect(sx, sy, tileSize, nowMs, player.id === meId);
      }

      this.ctx.fillStyle = '#f7f9ff';
      this.ctx.font = `${Math.max(9, Math.floor(tileSize * 0.36))}px monospace`;
      this.ctx.fillText(player.name.slice(0, 7), sx - tileSize * 0.45, sy - tileSize * 0.45);
    }
  }

  private drawPowerEffect(x: number, y: number, tileSize: number, nowMs: number, isMe: boolean): void {
    const base = tileSize * 0.52;
    const phase = (nowMs % 1200) / 1200;

    for (let ring = 0; ring < 3; ring += 1) {
      const p = (phase + ring * 0.22) % 1;
      const radius = base + tileSize * (0.18 + p * 0.75);
      const alpha = (1 - p) * (isMe ? 0.52 : 0.42);
      this.circle(x, y, radius, `rgba(95, 238, 255, ${alpha.toFixed(3)})`, false);
    }

    this.circle(x, y, base * 1.18, `rgba(82, 175, 255, ${isMe ? '0.26' : '0.18'})`);

    const sparks = 8;
    for (let i = 0; i < sparks; i += 1) {
      const angle = ((Math.PI * 2) / sparks) * i + phase * Math.PI * 2;
      const rr = base * (1.2 + ((i % 2 === 0 ? phase : 1 - phase) * 0.7));
      const sx = x + Math.cos(angle) * rr;
      const sy = y + Math.sin(angle) * rr;
      this.circle(sx, sy, Math.max(1.8, tileSize * 0.07), 'rgba(165, 249, 255, 0.88)');
    }
  }

  private updateEntityInterpolationMap(
    map: Map<string, InterpolationState>,
    entities: Array<{ id: string; x: number; y: number }>,
    nowMs: number,
    teleportThreshold: number,
  ): void {
    const aliveIds = new Set<string>();

    for (const entity of entities) {
      aliveIds.add(entity.id);

      const previous = map.get(entity.id);
      if (!previous) {
        map.set(entity.id, {
          fromX: entity.x,
          fromY: entity.y,
          toX: entity.x,
          toY: entity.y,
          updatedAtMs: nowMs,
        });
        continue;
      }

      let fromX = previous.toX;
      let fromY = previous.toY;
      const jumpDistance = Math.abs(fromX - entity.x) + Math.abs(fromY - entity.y);
      if (jumpDistance > teleportThreshold) {
        fromX = entity.x;
        fromY = entity.y;
      }

      map.set(entity.id, {
        fromX,
        fromY,
        toX: entity.x,
        toY: entity.y,
        updatedAtMs: nowMs,
      });
    }

    for (const existingId of map.keys()) {
      if (!aliveIds.has(existingId)) {
        map.delete(existingId);
      }
    }
  }

  private getInterpolationAlpha(state: ClientState): number {
    const tickRate = state.config?.tickRate ?? 20;
    const frameMs = 1000 / Math.max(1, tickRate);
    const elapsedMs = performance.now() - state.latestSnapshotReceivedAtMs;
    return clampNumber(elapsedMs / frameMs, 0, 1);
  }

  private getInterpolatedPosition(
    entityId: string,
    currentX: number,
    currentY: number,
    map: Map<string, InterpolationState>,
    alpha: number,
  ): { x: number; y: number } {
    const item = map.get(entityId);
    if (!item) {
      return { x: currentX, y: currentY };
    }

    return {
      x: item.fromX + (item.toX - item.fromX) * alpha,
      y: item.fromY + (item.toY - item.fromY) * alpha,
    };
  }

  private sectorAt(worldState: WorldInit, state: Snapshot, x: number, y: number) {
    const col = Math.floor(x / worldState.sectorSize);
    const row = Math.floor(y / worldState.sectorSize);
    const id = row * worldState.side + col;
    return state.sectors[id] ?? null;
  }

  private circle(x: number, y: number, radius: number, color: string, fill = true): void {
    this.ctx.beginPath();
    this.ctx.arc(x, y, radius, 0, Math.PI * 2);
    if (fill) {
      this.ctx.fillStyle = color;
      this.ctx.fill();
    } else {
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = 2;
      this.ctx.stroke();
    }
  }

  private drawCenteredText(text: string, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.font = '20px monospace';
    const width = this.ctx.measureText(text).width;
    this.ctx.fillText(text, (this.canvas.width - width) / 2, this.canvas.height / 2);
  }
}

function mustCanvasContext(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = target.getContext('2d');
  if (!context) {
    throw new Error('canvas context not available');
  }
  return context;
}
