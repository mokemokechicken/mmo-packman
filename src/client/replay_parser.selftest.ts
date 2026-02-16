import assert from 'node:assert/strict';
import type { GameSummary, Snapshot, WorldInit } from '../shared/types.js';
import { cloneSnapshot, cloneWorld, normalizeSnapshot, normalizeSummary } from './replay_model.js';
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

function makeWorld(): WorldInit {
  return {
    width: 4,
    height: 4,
    sectorSize: 2,
    side: 2,
    tiles: ['....', '....', '....', '....'],
    sectors: [
      {
        id: 1,
        row: 0,
        col: 0,
        x: 0,
        y: 0,
        size: 2,
        type: 'normal',
        discovered: false,
        captured: false,
        dotCount: 2,
        totalDots: 2,
      },
    ],
    gates: [
      {
        id: 'g-1',
        a: { x: 0, y: 1 },
        b: { x: 3, y: 1 },
        switchA: { x: 1, y: 1 },
        switchB: { x: 2, y: 1 },
        open: false,
        permanent: false,
      },
    ],
    dots: [
      [1, 1],
      [1, 2],
    ],
    powerPellets: [{ key: '2,2', x: 2, y: 2, active: true }],
  };
}

function makeReplay() {
  return {
    format: 'mmo-packman-replay-v1' as const,
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
      difficulty: 'normal' as const,
    },
    world: makeWorld(),
    startedAtMs: 1000,
    summary: {
      reason: 'timeout' as const,
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
  const replay = makeReplay();

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

function testRejectMalformedSnapshotCollections(): void {
  const malformed = makeReplay();
  malformed.frames[0] = {
    ...malformed.frames[0],
    snapshot: {
      ...malformed.frames[0].snapshot,
      pings: 'oops',
    } as unknown as Snapshot,
  };
  assert.doesNotThrow(() => parseReplayLog(malformed));
  assert.equal(parseReplayLog(malformed), null);
}

function testAcceptSnapshotWithoutPings(): void {
  const replay = makeReplay();
  const snapshotWithoutPings = { ...replay.frames[0].snapshot } as Record<string, unknown>;
  delete snapshotWithoutPings.pings;
  replay.frames[0] = {
    ...replay.frames[0],
    snapshot: snapshotWithoutPings as unknown as Snapshot,
  };
  const parsed = parseReplayLog(replay);
  assert.ok(parsed);
  assert.deepEqual(parsed?.frames[0].snapshot.pings, []);
}

function testRejectMalformedWorldCollections(): void {
  const malformed = makeReplay();
  malformed.world = {
    ...malformed.world,
    tiles: 'oops',
  } as unknown as WorldInit;
  assert.equal(parseReplayLog(malformed), null);
}

function testReplayModelUtilities(): void {
  const world = makeWorld();
  const worldCloned = cloneWorld(world);
  world.tiles[0] = '####';
  world.sectors[0].captured = true;
  world.gates[0].a.x = 99;
  world.dots[0][0] = 99;
  world.powerPellets[0].active = false;
  assert.equal(worldCloned.tiles[0], '....');
  assert.equal(worldCloned.sectors[0].captured, false);
  assert.equal(worldCloned.gates[0].a.x, 0);
  assert.equal(worldCloned.dots[0][0], 1);
  assert.equal(worldCloned.powerPellets[0].active, true);

  const snapshot: Snapshot = {
    ...makeSnapshot(1, 1100),
    players: [
      {
        id: 'p1',
        name: 'Alice',
        x: 1,
        y: 1,
        dir: 'left',
        state: 'normal',
        stocks: 3,
        gauge: 10,
        gaugeMax: 100,
        score: 100,
        connected: true,
        ai: false,
        speedBuffUntil: 0,
        powerUntil: 0,
        downSince: null,
      },
    ],
    ghosts: [
      {
        id: 'g1',
        x: 2,
        y: 2,
        dir: 'right',
        type: 'random',
        hp: 3,
        stunnedUntil: 0,
      },
    ],
    fruits: [{ id: 'f1', type: 'apple', x: 3, y: 3, spawnedAt: 1000 }],
    sectors: [...makeWorld().sectors],
    gates: [...makeWorld().gates],
    pings: [
      {
        id: 'ping-1',
        ownerId: 'p1',
        ownerName: 'Alice',
        x: 1,
        y: 2,
        kind: 'focus',
        createdAtMs: 1000,
        expiresAtMs: 2000,
      },
    ],
    events: [{ type: 'toast', message: 'hello' }],
    timeline: [{ atMs: 1000, label: 'tick-1' }],
  };
  const snapshotCloned = cloneSnapshot(snapshot);
  snapshot.players[0].name = 'Bob';
  snapshot.ghosts[0].x = 9;
  snapshot.fruits[0].x = 9;
  snapshot.sectors[0].captured = true;
  snapshot.gates[0].open = true;
  snapshot.pings[0].kind = 'danger';
  snapshot.events[0] = { type: 'toast', message: 'updated' };
  snapshot.timeline[0].label = 'tick-2';
  assert.equal(snapshotCloned.players[0].name, 'Alice');
  assert.equal(snapshotCloned.ghosts[0].x, 2);
  assert.equal(snapshotCloned.fruits[0].x, 3);
  assert.equal(snapshotCloned.sectors[0].captured, false);
  assert.equal(snapshotCloned.gates[0].open, false);
  assert.equal(snapshotCloned.pings[0].kind, 'focus');
  assert.equal(snapshotCloned.events[0].type, 'toast');
  assert.equal(snapshotCloned.timeline[0].label, 'tick-1');

  const summary = normalizeSummary({
    reason: 'timeout',
    durationMs: 1000,
    captureRatio: 0.5,
    timeline: [],
    ranking: [],
  } as unknown as GameSummary);
  assert.deepEqual(summary.awards, []);

  const normalizedSnapshot = normalizeSnapshot({
    ...makeSnapshot(2, 1200),
    pings: undefined,
  } as unknown as Snapshot);
  assert.deepEqual(normalizedSnapshot.pings, []);
}

function main(): void {
  testFindReplayFrameIndex();
  testParseReplayLog();
  testRejectLegacyFrameShape();
  testRejectMalformedSnapshotCollections();
  testAcceptSnapshotWithoutPings();
  testRejectMalformedWorldCollections();
  testReplayModelUtilities();
  console.log('[replay_parser.selftest] ok');
}

main();
