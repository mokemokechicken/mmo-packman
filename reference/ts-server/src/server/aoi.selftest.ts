import assert from 'node:assert/strict';
import type { Snapshot } from '../shared/types.js';
import { buildAoiSnapshot } from './aoi.js';

function sampleSnapshot(): Snapshot {
  return {
    tick: 1,
    nowMs: 1000,
    timeLeftMs: 5000,
    captureRatio: 0.2,
    players: [
      {
        id: 'p1',
        name: 'P1',
        x: 5,
        y: 5,
        dir: 'none',
        state: 'normal',
        stocks: 0,
        gauge: 0,
        gaugeMax: 20,
        score: 0,
        connected: true,
        ai: false,
        speedBuffUntil: 0,
        powerUntil: 0,
        downSince: null,
      },
      {
        id: 'p2',
        name: 'P2',
        x: 6,
        y: 5,
        dir: 'none',
        state: 'normal',
        stocks: 0,
        gauge: 0,
        gaugeMax: 20,
        score: 0,
        connected: true,
        ai: false,
        speedBuffUntil: 0,
        powerUntil: 0,
        downSince: null,
      },
      {
        id: 'p3',
        name: 'P3',
        x: 30,
        y: 30,
        dir: 'none',
        state: 'normal',
        stocks: 0,
        gauge: 0,
        gaugeMax: 20,
        score: 0,
        connected: true,
        ai: false,
        speedBuffUntil: 0,
        powerUntil: 0,
        downSince: null,
      },
    ],
    ghosts: [
      { id: 'g1', x: 7, y: 5, dir: 'left', type: 'chaser', hp: 1, stunnedUntil: 0 },
      { id: 'g2', x: 40, y: 40, dir: 'left', type: 'chaser', hp: 1, stunnedUntil: 0 },
    ],
    fruits: [
      { id: 'f1', type: 'apple', x: 7, y: 6, spawnedAt: 0 },
      { id: 'f2', type: 'apple', x: 42, y: 41, spawnedAt: 0 },
    ],
    sectors: [
      {
        id: 0,
        row: 0,
        col: 0,
        x: 0,
        y: 0,
        size: 17,
        type: 'normal',
        discovered: true,
        captured: false,
        dotCount: 1,
        totalDots: 2,
      },
    ],
    gates: [],
    pings: [
      {
        id: 'ping-near',
        ownerId: 'p2',
        ownerName: 'P2',
        x: 6,
        y: 5,
        kind: 'focus',
        createdAtMs: 0,
        expiresAtMs: 8000,
      },
      {
        id: 'ping-far',
        ownerId: 'p3',
        ownerName: 'P3',
        x: 30,
        y: 30,
        kind: 'focus',
        createdAtMs: 0,
        expiresAtMs: 8000,
      },
    ],
    events: [
      { type: 'dot_eaten', x: 6, y: 5, by: 'p2' },
      { type: 'dot_eaten', x: 25, y: 25, by: 'p3' },
      { type: 'toast', message: 'global' },
    ],
    timeline: [],
  };
}

function main(): void {
  const snapshot = sampleSnapshot();

  const scoped = buildAoiSnapshot(snapshot, 'p1', false, 8);
  assert.equal(scoped.players.some((player) => player.id === 'p1'), true);
  assert.equal(scoped.players.some((player) => player.id === 'p2'), true);
  assert.equal(scoped.players.some((player) => player.id === 'p3'), false);
  assert.equal(scoped.ghosts.length, 1);
  assert.equal(scoped.fruits.length, 1);
  assert.equal(scoped.pings.length, 1);
  assert.equal(scoped.events.length, 3);

  const spectator = buildAoiSnapshot(snapshot, 'p1', true, 8);
  assert.equal(spectator.players.length, snapshot.players.length);
  assert.equal(spectator.ghosts.length, snapshot.ghosts.length);

  const fullBytes = JSON.stringify(snapshot).length;
  const scopedBytes = JSON.stringify(scoped).length;
  assert.equal(scopedBytes < fullBytes, true);

  const bossSnapshot = sampleSnapshot();
  bossSnapshot.ghosts = [];
  bossSnapshot.events = [{ type: 'boss_hit', ghostId: 'g-gone', hp: 0, by: 'p2' }];
  const bossScoped = buildAoiSnapshot(bossSnapshot, 'p1', false, 8);
  assert.equal(bossScoped.events.length, 1);

  const sectorSnapshot = sampleSnapshot();
  sectorSnapshot.players[0] = {
    ...(sectorSnapshot.players[0] as Snapshot['players'][number]),
    x: 16,
    y: 1,
  };
  sectorSnapshot.events = [{ type: 'sector_captured', sectorId: 0 }];
  const sectorScoped = buildAoiSnapshot(sectorSnapshot, 'p1', false, 1);
  assert.equal(sectorScoped.events.length, 1);

  console.log('[aoi.selftest] ok');
}

main();
