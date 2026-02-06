import assert from 'node:assert/strict';
import { parseServerMessage } from './parseServerMessage.js';

const validStatePayload: any = {
  type: 'state',
  snapshot: {
    tick: 1,
    nowMs: 1000,
    timeLeftMs: 59_000,
    captureRatio: 0.1,
    players: [
      {
        id: 'p1',
        name: 'P1',
        x: 1,
        y: 1,
        dir: 'right',
        state: 'normal',
        stocks: 1,
        gauge: 0,
        gaugeMax: 100,
        score: 0,
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
        dir: 'left',
        type: 'random',
        hp: 1,
        stunnedUntil: 0,
      },
    ],
    fruits: [],
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
        dotCount: 10,
        totalDots: 100,
      },
    ],
    gates: [],
    events: [
      { type: 'toast', message: 'ok' },
      { type: 'unknown_event', any: 1 },
    ],
    timeline: [{ atMs: 0, label: 'start' }],
  },
};

function run(): void {
  const welcome = parseServerMessage(
    JSON.stringify({
      type: 'welcome',
      playerId: 'p1',
      reconnectToken: 'token',
      isHost: true,
      isSpectator: false,
    }),
  );
  assert.ok(welcome && welcome.type === 'welcome');

  const invalidWorld = parseServerMessage(
    JSON.stringify({
      type: 'game_init',
      meId: 'p1',
      isSpectator: false,
      startedAtMs: 0,
      config: {
        tickRate: 20,
        dotsForAwaken: 100,
        awakenMaxStock: 3,
        powerDurationMs: 5000,
        awakenDurationMs: 5000,
        rescueTimeoutMs: 5000,
        timeLimitMs: 60_000,
        difficulty: 'normal',
      },
      world: {
        width: 3,
        height: 2,
        sectorSize: 17,
        side: 1,
        tiles: ['...'], // invalid: length mismatch
        sectors: [],
        gates: [],
        dots: [],
        powerPellets: [],
      },
    }),
  );
  assert.equal(invalidWorld, null);

  const state = parseServerMessage(JSON.stringify(validStatePayload));
  assert.ok(state && state.type === 'state');
  if (!state || state.type !== 'state') {
    throw new Error('state parse failed');
  }
  assert.equal(state.snapshot.events.length, 1);
  assert.equal(state.snapshot.events[0]?.type, 'toast');

  const invalidStocksPayload = structuredClone(validStatePayload);
  (invalidStocksPayload.snapshot.players[0] as { stocks: number }).stocks = -1;
  const invalidStocksState = parseServerMessage(JSON.stringify(invalidStocksPayload));
  assert.equal(invalidStocksState, null);

  const hugeStocksPayload = structuredClone(validStatePayload);
  (hugeStocksPayload.snapshot.players[0] as { stocks: number }).stocks = 10_000;
  const hugeStocksState = parseServerMessage(JSON.stringify(hugeStocksPayload));
  assert.equal(hugeStocksState, null);

  const invalidKnownEventPayload = structuredClone(validStatePayload);
  invalidKnownEventPayload.snapshot.events = [{ type: 'dot_eaten', x: 1, y: 1 }]; // missing by
  const invalidKnownEventState = parseServerMessage(JSON.stringify(invalidKnownEventPayload));
  assert.equal(invalidKnownEventState, null);

  console.log('parseServerMessage selftest: OK');
}

run();
