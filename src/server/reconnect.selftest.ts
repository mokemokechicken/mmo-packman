import assert from 'node:assert/strict';
import { GameEngine, type StartPlayer } from './game.js';

function run(): void {
  const players: StartPlayer[] = [
    {
      id: 'p1',
      name: 'P1',
      reconnectToken: 'token_p1',
      connected: true,
    },
  ];
  const engine: any = new GameEngine(players, 'normal', 31, { timeLimitMsOverride: 60_000 });

  const byToken = engine.getPlayerByToken('token_p1');
  assert.ok(byToken);
  assert.equal(byToken.id, 'p1');

  engine.setPlayerConnection('p1', false);
  assert.equal(byToken.connected, false);
  assert.equal(byToken.ai, true);

  engine.setPlayerConnection('p1', true);
  assert.equal(byToken.connected, true);
  assert.equal(byToken.ai, false);

  console.log('server reconnect selftest: OK');
}

run();
