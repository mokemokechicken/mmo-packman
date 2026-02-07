import assert from 'node:assert/strict';
import { PingManager } from './ping_manager.js';

function testSpectatorDenied(): void {
  const manager = new PingManager({ ttlMs: 1_000 });
  const result = manager.place({
    ownerId: 'p1',
    ownerName: 'Spec',
    x: 1,
    y: 1,
    kind: 'focus',
    nowMs: 100,
    spectator: true,
  });
  assert.equal(result.ok, false);
  assert.equal(manager.snapshot(100).length, 0);
}

function testTtlCleanup(): void {
  const manager = new PingManager({ ttlMs: 1_000 });
  const result = manager.place({
    ownerId: 'p1',
    ownerName: 'Alice',
    x: 2,
    y: 3,
    kind: 'danger',
    nowMs: 0,
    spectator: false,
  });
  assert.equal(result.ok, true);
  assert.equal(manager.snapshot(999).length, 1);
  assert.equal(manager.snapshot(1_000).length, 0);
}

function testRateLimit(): void {
  const manager = new PingManager({ rateWindowMs: 4_000, maxPerWindow: 3 });
  const times = [0, 100, 200];
  for (const time of times) {
    assert.equal(
      manager.place({
        ownerId: 'p1',
        ownerName: 'Alice',
        x: 1,
        y: 1,
        kind: 'help',
        nowMs: time,
        spectator: false,
      }).ok,
      true,
    );
  }

  const blocked = manager.place({
    ownerId: 'p1',
    ownerName: 'Alice',
    x: 1,
    y: 1,
    kind: 'help',
    nowMs: 300,
    spectator: false,
  });
  assert.equal(blocked.ok, false);

  const afterWindow = manager.place({
    ownerId: 'p1',
    ownerName: 'Alice',
    x: 1,
    y: 1,
    kind: 'help',
    nowMs: 4_500,
    spectator: false,
  });
  assert.equal(afterWindow.ok, true);
}

function testPerPlayerCap(): void {
  const manager = new PingManager({ maxPerPlayer: 2, ttlMs: 20_000 });
  assert.equal(
    manager.place({
      ownerId: 'p1',
      ownerName: 'Alice',
      x: 1,
      y: 1,
      kind: 'focus',
      nowMs: 0,
      spectator: false,
    }).ok,
    true,
  );
  assert.equal(
    manager.place({
      ownerId: 'p1',
      ownerName: 'Alice',
      x: 2,
      y: 1,
      kind: 'focus',
      nowMs: 100,
      spectator: false,
    }).ok,
    true,
  );
  assert.equal(
    manager.place({
      ownerId: 'p1',
      ownerName: 'Alice',
      x: 3,
      y: 1,
      kind: 'focus',
      nowMs: 200,
      spectator: false,
    }).ok,
    true,
  );

  const pings = manager.snapshot(250);
  assert.equal(pings.length, 2);
  assert.equal(pings.every((ping) => ping.ownerId === 'p1'), true);
  assert.equal(pings.some((ping) => ping.x === 1), false);
}

function testGlobalCap(): void {
  const manager = new PingManager({
    maxActivePings: 3,
    maxPerPlayer: 10,
    maxPerWindow: 20,
    rateWindowMs: 10_000,
    ttlMs: 60_000,
  });

  for (let i = 0; i < 5; i += 1) {
    assert.equal(
      manager.place({
        ownerId: `p${i}`,
        ownerName: `P${i}`,
        x: i,
        y: 0,
        kind: 'focus',
        nowMs: i * 100,
        spectator: false,
      }).ok,
      true,
    );
  }

  const pings = manager.snapshot(1_000);
  assert.equal(pings.length, 3);
  assert.equal(pings.map((ping) => ping.ownerId).join(','), 'p2,p3,p4');
}

function main(): void {
  testSpectatorDenied();
  testTtlCleanup();
  testRateLimit();
  testPerPlayerCap();
  testGlobalCap();
  console.log('[ping_manager.selftest] ok');
}

main();
