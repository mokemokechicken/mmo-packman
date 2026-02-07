import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GameSummary } from '../shared/types.js';
import { RankingStore } from './ranking_store.js';

function makeSummary(reason: GameSummary['reason'], captureRatio: number, rows: Array<{ id: string; name: string; score: number; rescues: number }>): GameSummary {
  return {
    reason,
    durationMs: 60_000,
    captureRatio,
    timeline: [],
    ranking: rows.map((row) => ({
      playerId: row.id,
      name: row.name,
      score: row.score,
      dots: 0,
      ghosts: 0,
      rescues: row.rescues,
      captures: 0,
    })),
  };
}

function main(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ranking-store-'));
  const filePath = path.join(dir, 'ranking.json');

  const store = new RankingStore(filePath);
  store.recordMatch(
    makeSummary('victory', 0.8, [
      { id: 'p1', name: 'Alice', score: 100, rescues: 3 },
      { id: 'ai_x1', name: 'AI-01', score: 120, rescues: 0 },
    ]),
  );
  store.recordMatch(
    makeSummary('timeout', 0.4, [
      { id: 'p1', name: 'Alice', score: 50, rescues: 1 },
      { id: 'p2', name: 'Bob', score: 80, rescues: 2 },
    ]),
  );

  const entries = store.getTop(10);
  assert.equal(entries.length, 2);

  const alice = entries.find((entry) => entry.name === 'Alice');
  assert.ok(alice);
  assert.equal(alice?.matches, 2);
  assert.equal(alice?.wins, 1);
  assert.equal(alice?.bestScore, 100);

  const restored = new RankingStore(filePath);
  const restoredEntries = restored.getTop(10);
  assert.equal(restoredEntries.length, 2);
  assert.equal(restoredEntries.some((entry) => /^AI-/i.test(entry.name)), false);

  const brokenFilePath = path.join(dir, 'broken.json');
  fs.writeFileSync(
    brokenFilePath,
    JSON.stringify({
      version: 1,
      players: {
        alice: null,
      },
    }),
  );
  const broken = new RankingStore(brokenFilePath);
  assert.deepEqual(broken.getTop(10), []);

  const mergedFilePath = path.join(dir, 'merged.json');
  fs.writeFileSync(
    mergedFilePath,
    JSON.stringify({
      version: 1,
      players: {
        ALICE: {
          name: 'Alice',
          matches: 2,
          wins: 1,
          totalCaptureRatio: 1.0,
          totalRescues: 3,
          bestScore: 120,
          updatedAtMs: 10,
        },
        alice_legacy: {
          name: ' alice ',
          matches: 1,
          wins: 1,
          totalCaptureRatio: 0.7,
          totalRescues: 1,
          bestScore: 80,
          updatedAtMs: 20,
        },
        invalid: {
          name: 'Broken',
          matches: -1,
        },
      },
    }),
  );
  const merged = new RankingStore(mergedFilePath);
  const mergedEntries = merged.getTop(10);
  assert.equal(mergedEntries.length, 1);
  assert.equal(mergedEntries[0]?.name, 'alice');
  assert.equal(mergedEntries[0]?.matches, 3);
  assert.equal(mergedEntries[0]?.wins, 2);

  console.log('[ranking_store.selftest] ok');
}

main();
