import assert from 'node:assert/strict';
import { parseClientMessage } from './message_parser.js';

function run(): void {
  const hello = parseClientMessage(
    JSON.stringify({ type: 'hello', name: 'p1', reconnectToken: 'token', spectator: false }),
  );
  assert.ok(hello && hello.type === 'hello');

  const invalidHello = parseClientMessage(JSON.stringify({ type: 'hello', name: 123 }));
  assert.equal(invalidHello, null);

  const start = parseClientMessage(
    JSON.stringify({ type: 'lobby_start', difficulty: 'normal', aiPlayerCount: 5, timeLimitMinutes: 3 }),
  );
  assert.ok(start && start.type === 'lobby_start');

  const invalidStart = parseClientMessage(JSON.stringify({ type: 'lobby_start', difficulty: 'impossible' }));
  assert.equal(invalidStart, null);

  const input = parseClientMessage(JSON.stringify({ type: 'input', dir: 'left', awaken: true }));
  assert.ok(input && input.type === 'input');

  const invalidInput = parseClientMessage(JSON.stringify({ type: 'input', dir: 'none' }));
  assert.equal(invalidInput, null);

  const ping = parseClientMessage(JSON.stringify({ type: 'ping', t: 1 }));
  assert.ok(ping && ping.type === 'ping');

  const invalidJson = parseClientMessage('{invalid');
  assert.equal(invalidJson, null);

  console.log('message parser selftest: OK');
}

run();
