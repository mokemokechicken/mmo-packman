import assert from 'node:assert/strict';
import type { Snapshot } from '../shared/types.js';
import {
  applyRuntimeEvent,
  currentFollowName,
  dotKey,
  resolveFocusPlayer,
  type ClientState,
} from './state.js';

function createState(): ClientState {
  return {
    reconnectToken: '',
    playerName: 'Tester',
    preferSpectator: false,
    requestedAiCount: 2,
    requestedTestMinutes: 5,
    sessionId: 's1',
    meId: 'p1',
    isHost: false,
    isSpectator: false,
    world: null,
    config: null,
    snapshot: null,
    summary: null,
    lobbyMessage: '',
    logs: [],
    currentDir: 'none',
    followPlayerId: null,
    latestSnapshotReceivedAtMs: 0,
    dotSet: new Set<string>(),
    pelletMap: new Map<string, { x: number; y: number; active: boolean }>(),
    playerInterpolation: new Map(),
    ghostInterpolation: new Map(),
  };
}

function createSnapshot(): Snapshot {
  return {
    tick: 1,
    nowMs: 1000,
    timeLeftMs: 10_000,
    captureRatio: 0.2,
    players: [
      {
        id: 'p1',
        name: 'Alice',
        x: 1,
        y: 1,
        dir: 'none',
        state: 'normal',
        stocks: 1,
        gauge: 2,
        gaugeMax: 10,
        score: 30,
        connected: true,
        ai: false,
        speedBuffUntil: 0,
        powerUntil: 0,
        downSince: null,
      },
      {
        id: 'p2',
        name: 'Bob',
        x: 2,
        y: 2,
        dir: 'none',
        state: 'normal',
        stocks: 2,
        gauge: 4,
        gaugeMax: 10,
        score: 120,
        connected: true,
        ai: true,
        speedBuffUntil: 0,
        powerUntil: 0,
        downSince: null,
      },
    ],
    ghosts: [],
    fruits: [],
    sectors: [],
    gates: [],
    events: [],
    timeline: [],
  };
}

function testRuntimeEventApplication(): void {
  const state = createState();
  state.snapshot = createSnapshot();

  const dKey = dotKey(3, 4);
  state.dotSet.add(dKey);
  applyRuntimeEvent(state, { type: 'dot_eaten', x: 3, y: 4, by: 'p1' });
  assert.equal(state.dotSet.has(dKey), false);

  applyRuntimeEvent(state, { type: 'dot_respawned', x: 3, y: 4 });
  assert.equal(state.dotSet.has(dKey), true);

  state.pelletMap.set('3,5', { x: 3, y: 5, active: true });
  applyRuntimeEvent(state, { type: 'pellet_taken', key: '3,5' });
  assert.equal(state.pelletMap.get('3,5')?.active, false);

  applyRuntimeEvent(state, { type: 'pellet_respawned', key: '3,5' });
  assert.equal(state.pelletMap.get('3,5')?.active, true);

  applyRuntimeEvent(state, { type: 'fruit_taken', fruitId: 'f1', by: 'p1', fruitType: 'apple' });
  applyRuntimeEvent(state, { type: 'player_down', playerId: 'p2' });
  assert.equal(state.logs.length >= 2, true);
  assert.equal(state.logs.some((line) => line.includes('Alice')), true);
  assert.equal(state.logs.some((line) => line.includes('Bob')), true);
}

function testFocusResolution(): void {
  const state = createState();
  state.snapshot = createSnapshot();

  state.isSpectator = false;
  state.meId = 'p1';
  assert.equal(resolveFocusPlayer(state)?.id, 'p1');

  state.isSpectator = true;
  state.followPlayerId = null;
  assert.equal(resolveFocusPlayer(state)?.id, 'p2');
  assert.equal(currentFollowName(state), 'Bob');

  state.followPlayerId = 'p1';
  assert.equal(resolveFocusPlayer(state)?.id, 'p1');
  assert.equal(currentFollowName(state), 'Alice');
}

function run(): void {
  testRuntimeEventApplication();
  testFocusResolution();
  console.log('client state selftest: OK');
}

run();
