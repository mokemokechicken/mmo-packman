import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { SessionManager } from './session_manager.js';

interface MockSocket {
  OPEN: number;
  readyState: number;
  closed: Array<{ code: number; reason: string }>;
  close: (code?: number, reason?: string) => void;
}

function createMockSocket(): MockSocket {
  const socket: MockSocket = {
    OPEN: 1,
    readyState: 1,
    closed: [],
    close(code = 1000, reason = '') {
      socket.closed.push({ code, reason });
      socket.readyState = 3;
    },
  };
  return socket;
}

function run(): void {
  const sessions = new SessionManager();
  const ws1 = createMockSocket();
  const ws2 = createMockSocket();

  const c1 = sessions.createClient(ws1 as unknown as WebSocket);
  sessions.bindClientToPlayer(c1, 'p1');
  assert.equal(c1.playerId, 'p1');
  assert.equal(sessions.getClientByPlayerId('p1')?.id, c1.id);

  const c2 = sessions.createClient(ws2 as unknown as WebSocket);
  sessions.bindClientToPlayer(c2, 'p1');
  assert.equal(c1.playerId, null);
  assert.equal(c2.playerId, 'p1');
  assert.equal(sessions.getClientByPlayerId('p1')?.id, c2.id);
  assert.equal(ws1.closed[0]?.code, 4001);

  assert.equal(sessions.isActiveClient(c1), false);
  assert.equal(sessions.isActiveClient(c2), true);

  const ws3 = createMockSocket();
  const c3 = sessions.createClient(ws3 as unknown as WebSocket);
  sessions.bindClientToPlayer(c3, 'p3');
  assert.equal(sessions.getClientByPlayerId('p3')?.id, c3.id);
  sessions.resetBinding(c3);
  assert.equal(c3.playerId, null);
  assert.equal(sessions.getClientByPlayerId('p3'), null);

  const ws4 = createMockSocket();
  const ws5 = createMockSocket();
  const c4 = sessions.createClient(ws4 as unknown as WebSocket);
  const c5 = sessions.createClient(ws5 as unknown as WebSocket);
  sessions.bindClientToPlayer(c4, 'p4');
  sessions.bindClientToPlayer(c5, 'p4');
  sessions.resetBinding(c4); // stale reset must not affect active mapping
  assert.equal(sessions.getClientByPlayerId('p4')?.id, c5.id);

  const staleClose = sessions.removeClient(c1);
  assert.equal(staleClose.wasActive, false);
  assert.equal(staleClose.boundPlayerId, null);

  const activeClose = sessions.removeClient(c2);
  assert.equal(activeClose.wasActive, true);
  assert.equal(activeClose.boundPlayerId, 'p1');

  console.log('session manager selftest: OK');
}

run();
