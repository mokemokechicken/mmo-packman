import { randomUUID } from 'node:crypto';
import type { PingType, PingView } from '../shared/types.js';

export interface PingManagerOptions {
  ttlMs?: number;
  maxActivePings?: number;
  maxPerPlayer?: number;
  rateWindowMs?: number;
  maxPerWindow?: number;
}

export interface PlacePingInput {
  ownerId: string;
  ownerName: string;
  x: number;
  y: number;
  kind: PingType;
  nowMs: number;
  spectator: boolean;
}

export interface PlacePingResult {
  ok: boolean;
  reason?: string;
}

interface PingManagerConfig {
  ttlMs: number;
  maxActivePings: number;
  maxPerPlayer: number;
  rateWindowMs: number;
  maxPerWindow: number;
}

const DEFAULT_CONFIG: PingManagerConfig = {
  ttlMs: 8_000,
  maxActivePings: 24,
  maxPerPlayer: 4,
  rateWindowMs: 4_000,
  maxPerWindow: 3,
};

export class PingManager {
  private readonly config: PingManagerConfig;
  private readonly pings: PingView[] = [];
  private readonly historyByOwner = new Map<string, number[]>();

  public constructor(options: PingManagerOptions = {}) {
    this.config = {
      ttlMs: options.ttlMs ?? DEFAULT_CONFIG.ttlMs,
      maxActivePings: options.maxActivePings ?? DEFAULT_CONFIG.maxActivePings,
      maxPerPlayer: options.maxPerPlayer ?? DEFAULT_CONFIG.maxPerPlayer,
      rateWindowMs: options.rateWindowMs ?? DEFAULT_CONFIG.rateWindowMs,
      maxPerWindow: options.maxPerWindow ?? DEFAULT_CONFIG.maxPerWindow,
    };
  }

  public clear(): void {
    this.pings.splice(0, this.pings.length);
    this.historyByOwner.clear();
  }

  public place(input: PlacePingInput): PlacePingResult {
    this.prune(input.nowMs);

    if (input.spectator) {
      return {
        ok: false,
        reason: 'spectator cannot place ping',
      };
    }

    if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) {
      return {
        ok: false,
        reason: 'invalid ping coordinates',
      };
    }

    const history = this.historyByOwner.get(input.ownerId) ?? [];
    const recent = history.filter((time) => input.nowMs - time <= this.config.rateWindowMs);
    if (recent.length >= this.config.maxPerWindow) {
      this.historyByOwner.set(input.ownerId, recent);
      return {
        ok: false,
        reason: 'ping rate limit exceeded',
      };
    }
    recent.push(input.nowMs);
    this.historyByOwner.set(input.ownerId, recent);

    this.trimOwnerPings(input.ownerId);
    while (this.pings.length >= this.config.maxActivePings) {
      this.pings.shift();
    }

    this.pings.push({
      id: randomUUID(),
      ownerId: input.ownerId,
      ownerName: input.ownerName,
      x: input.x,
      y: input.y,
      kind: input.kind,
      createdAtMs: input.nowMs,
      expiresAtMs: input.nowMs + this.config.ttlMs,
    });

    return { ok: true };
  }

  public snapshot(nowMs: number): PingView[] {
    this.prune(nowMs);
    return this.pings.map((ping) => ({ ...ping }));
  }

  private prune(nowMs: number): void {
    for (let index = this.pings.length - 1; index >= 0; index -= 1) {
      const ping = this.pings[index] as PingView;
      if (ping.expiresAtMs <= nowMs) {
        this.pings.splice(index, 1);
      }
    }

    for (const [ownerId, history] of this.historyByOwner.entries()) {
      const recent = history.filter((time) => nowMs - time <= this.config.rateWindowMs);
      if (recent.length === 0) {
        this.historyByOwner.delete(ownerId);
      } else {
        this.historyByOwner.set(ownerId, recent);
      }
    }
  }

  private trimOwnerPings(ownerId: string): void {
    let ownerCount = this.pings.reduce((count, ping) => count + (ping.ownerId === ownerId ? 1 : 0), 0);
    if (ownerCount < this.config.maxPerPlayer) {
      return;
    }

    for (let index = 0; index < this.pings.length && ownerCount >= this.config.maxPerPlayer; index += 1) {
      const ping = this.pings[index] as PingView;
      if (ping.ownerId !== ownerId) {
        continue;
      }
      this.pings.splice(index, 1);
      ownerCount -= 1;
      index -= 1;
    }
  }
}
