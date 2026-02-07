import { performance } from 'node:perf_hooks';
import { GameEngine, type StartPlayer } from './game.js';
import { buildAoiSnapshot } from './aoi.js';

function buildPlayers(count: number): StartPlayer[] {
  const out: StartPlayer[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      id: `p${i + 1}`,
      name: `Player-${i + 1}`,
      reconnectToken: `token-${i + 1}`,
      connected: i < 6,
    });
  }
  return out;
}

function main(): void {
  const game = new GameEngine(buildPlayers(24), 'normal', 424242);
  for (let i = 0; i < 120; i += 1) {
    game.step(50);
  }

  const snapshot = game.buildSnapshot(true);
  const fullBytes = JSON.stringify(snapshot).length;

  let totalScopedBytes = 0;
  let sampleCount = 0;
  const players = snapshot.players.slice(0, 6);
  for (const viewer of players) {
    const scoped = buildAoiSnapshot(snapshot, viewer.id, false, 12);
    totalScopedBytes += JSON.stringify(scoped).length;
    sampleCount += 1;
  }

  const averageScopedBytes = sampleCount > 0 ? totalScopedBytes / sampleCount : fullBytes;
  const reductionRatio = fullBytes > 0 ? 1 - averageScopedBytes / fullBytes : 0;

  const iterations = 200;
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    for (const viewer of players) {
      buildAoiSnapshot(snapshot, viewer.id, false, 12);
    }
  }
  const elapsedMs = performance.now() - start;
  const avgPerSnapshotMs = elapsedMs / (iterations * Math.max(1, players.length));

  console.log(
    JSON.stringify(
      {
        fullBytes,
        averageScopedBytes: Math.round(averageScopedBytes),
        reductionPercent: Number((reductionRatio * 100).toFixed(1)),
        avgPerSnapshotMs: Number(avgPerSnapshotMs.toFixed(4)),
        samples: players.length,
      },
      null,
      2,
    ),
  );
}

main();
