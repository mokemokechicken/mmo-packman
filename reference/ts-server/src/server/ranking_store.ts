import fs from 'node:fs';
import path from 'node:path';
import type { GameSummary, PersistentRankingEntry, RankingResponse, ScoreEntry } from '../shared/types.js';

interface StoredRankingEntry {
  name: string;
  matches: number;
  wins: number;
  totalCaptureRatio: number;
  totalRescues: number;
  bestScore: number;
  updatedAtMs: number;
}

interface RankingStoreFile {
  version: 1;
  players: Record<string, StoredRankingEntry>;
}

const EMPTY_STORE: RankingStoreFile = {
  version: 1,
  players: {},
};

export class RankingStore {
  private data: RankingStoreFile = { ...EMPTY_STORE, players: {} };

  public constructor(private readonly filePath: string) {
    this.load();
  }

  public recordMatch(summary: GameSummary): void {
    const won = summary.reason === 'victory';
    const nowMs = Date.now();

    for (const entry of summary.ranking) {
      if (isAiPlayer(entry)) {
        continue;
      }

      const key = rankingKey(entry.name);
      const current = this.data.players[key] ?? {
        name: entry.name,
        matches: 0,
        wins: 0,
        totalCaptureRatio: 0,
        totalRescues: 0,
        bestScore: 0,
        updatedAtMs: nowMs,
      };

      current.name = entry.name;
      current.matches += 1;
      current.wins += won ? 1 : 0;
      current.totalCaptureRatio += summary.captureRatio;
      current.totalRescues += entry.rescues;
      current.bestScore = Math.max(current.bestScore, entry.score);
      current.updatedAtMs = nowMs;
      this.data.players[key] = current;
    }

    this.save();
  }

  public getTop(limit = 10): PersistentRankingEntry[] {
    const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 10;

    return Object.values(this.data.players)
      .map((entry): PersistentRankingEntry => ({
        name: entry.name,
        matches: entry.matches,
        wins: entry.wins,
        winRate: entry.matches > 0 ? entry.wins / entry.matches : 0,
        avgCaptureRatio: entry.matches > 0 ? entry.totalCaptureRatio / entry.matches : 0,
        avgRescues: entry.matches > 0 ? entry.totalRescues / entry.matches : 0,
        bestScore: entry.bestScore,
        updatedAtMs: entry.updatedAtMs,
      }))
      .sort((a, b) => {
        if (b.winRate !== a.winRate) {
          return b.winRate - a.winRate;
        }
        if (b.avgCaptureRatio !== a.avgCaptureRatio) {
          return b.avgCaptureRatio - a.avgCaptureRatio;
        }
        if (b.avgRescues !== a.avgRescues) {
          return b.avgRescues - a.avgRescues;
        }
        if (b.bestScore !== a.bestScore) {
          return b.bestScore - a.bestScore;
        }
        return a.name.localeCompare(b.name, 'ja');
      })
      .slice(0, normalizedLimit);
  }

  public buildResponse(limit = 10): RankingResponse {
    return {
      generatedAtIso: new Date().toISOString(),
      entries: this.getTop(limit),
    };
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.data = { ...EMPTY_STORE, players: {} };
        return;
      }

      const text = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(text) as unknown;
      if (!isRankingStoreFile(parsed)) {
        console.warn(`[ranking-store] invalid format: ${this.filePath}`);
        this.data = { ...EMPTY_STORE, players: {} };
        return;
      }

      const sanitizedPlayers: Record<string, StoredRankingEntry> = {};
      for (const [, value] of Object.entries(parsed.players)) {
        const sanitized = sanitizeStoredRankingEntry(value);
        if (!sanitized) {
          continue;
        }
        const normalizedKey = rankingKey(sanitized.name);
        const existing = sanitizedPlayers[normalizedKey];
        if (!existing) {
          sanitizedPlayers[normalizedKey] = sanitized;
          continue;
        }
        sanitizedPlayers[normalizedKey] = {
          name: sanitized.name,
          matches: existing.matches + sanitized.matches,
          wins: existing.wins + sanitized.wins,
          totalCaptureRatio: existing.totalCaptureRatio + sanitized.totalCaptureRatio,
          totalRescues: existing.totalRescues + sanitized.totalRescues,
          bestScore: Math.max(existing.bestScore, sanitized.bestScore),
          updatedAtMs: Math.max(existing.updatedAtMs, sanitized.updatedAtMs),
        };
      }
      this.data = {
        version: 1,
        players: sanitizedPlayers,
      };
    } catch (error) {
      console.warn(`[ranking-store] failed to load ${this.filePath}:`, error);
      this.data = { ...EMPTY_STORE, players: {} };
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.warn(`[ranking-store] failed to save ${this.filePath}:`, error);
    }
  }
}

function rankingKey(name: string): string {
  return name.trim().toLowerCase();
}

function isAiPlayer(entry: ScoreEntry): boolean {
  return entry.playerId.startsWith('ai_') || /^AI-/i.test(entry.name);
}

function isRankingStoreFile(value: unknown): value is RankingStoreFile {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const target = value as Partial<RankingStoreFile>;
  return target.version === 1 && !!target.players && typeof target.players === 'object' && !Array.isArray(target.players);
}

function sanitizeStoredRankingEntry(value: unknown): StoredRankingEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const target = value as Partial<StoredRankingEntry>;
  if (typeof target.name !== 'string' || target.name.trim().length === 0) {
    return null;
  }
  const normalizedName = target.name.trim();
  if (
    !isNonNegativeFinite(target.matches) ||
    !isNonNegativeFinite(target.wins) ||
    !isNonNegativeFinite(target.totalCaptureRatio) ||
    !isNonNegativeFinite(target.totalRescues) ||
    !isNonNegativeFinite(target.bestScore) ||
    !isNonNegativeFinite(target.updatedAtMs)
  ) {
    return null;
  }

  return {
    name: normalizedName,
    matches: Math.floor(target.matches),
    wins: Math.floor(Math.min(target.wins, target.matches)),
    totalCaptureRatio: target.totalCaptureRatio,
    totalRescues: target.totalRescues,
    bestScore: target.bestScore,
    updatedAtMs: target.updatedAtMs,
  };
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
