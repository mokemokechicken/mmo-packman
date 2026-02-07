import assert from 'node:assert/strict';
import type { Snapshot } from '../shared/types.js';
import { findReplayFrameIndex, parseReplayLog } from './replay_parser.js';

function makeSnapshot(tick: number, nowMs: number): Snapshot {
  return {
    tick,
    nowMs,
    timeLeftMs: 1000,
    captureRatio: 0,
    players: [],
    ghosts: [],
    fruits: [],
    sectors: [],
    gates: [],
    pings: [],
    events: [],
    timeline: [],
  };
}

function testFindReplayFrameIndex(): void {
  const offsets = [0, 400, 900, 1600];
  assert.equal(findReplayFrameIndex(offsets, 0), 0);
  assert.equal(findReplayFrameIndex(offsets, 399), 0);
  assert.equal(findReplayFrameIndex(offsets, 401), 1);
  assert.equal(findReplayFrameIndex(offsets, 999), 2);
  assert.equal(findReplayFrameIndex(offsets, 9999), 3);
}

function testParseReplayLog(): void {
  const replay = {
    format: 'mmo-packman-replay-v1',
    recordedAtIso: '2026-02-07T00:00:00.000Z',
    seed: 42,
    config: {
      tickRate: 20,
      dotsForAwaken: 20,
      awakenMaxStock: 3,
      powerDurationMs: 8000,
      awakenDurationMs: 5000,
      rescueTimeoutMs: 6000,
      timeLimitMs: 300000,
      difficulty: 'normal',
    },
    world: {
      width: 4,
      height: 4,
      sectorSize: 2,
      side: 2,
      tiles: ['....', '....', '....', '....'],
      sectors: [],
      gates: [],
      dots: [
        [1, 1],
        [1, 2],
      ],
      powerPellets: [
        { key: '2,2', x: 2, y: 2, active: true },
      ],
    },
    startedAtMs: 1000,
    summary: {
      reason: 'timeout',
      durationMs: 1000,
      captureRatio: 0.3,
      timeline: [],
      ranking: [],
      awards: [],
    },
    frames: [
      {
        snapshot: makeSnapshot(0, 1000),
        dots: ['1,1'],
        pellets: [{ key: '2,2', x: 2, y: 2, active: true }],
      },
    ],
  };

  const parsed = parseReplayLog(replay);
  assert.ok(parsed);
  assert.equal(parsed?.seed, 42);
  assert.equal(parsed?.frames.length, 1);
  assert.equal(parsed?.frames[0]?.dots[0], '1,1');
}

function testRejectLegacyFrameShape(): void {
  const legacy = {
    format: 'mmo-packman-replay-v1',
    seed: 1,
    config: {},
    world: {},
    startedAtMs: 0,
    summary: {},
    frames: [{ tick: 0, nowMs: 0 }],
  };
  assert.equal(parseReplayLog(legacy), null);
}

function main(): void {
  testFindReplayFrameIndex();
  testParseReplayLog();
  testRejectLegacyFrameShape();
  console.log('[replay_parser.selftest] ok');
}

main();
