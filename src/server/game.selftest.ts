import assert from 'node:assert/strict';
import { keyOf } from './helpers.js';
import { GameEngine, type StartPlayer } from './game.js';

interface TestEngine {
  players: Map<string, any>;
  ghosts: Map<string, any>;
  world: {
    sectors: Array<{ id: number; floorCells: Array<{ x: number; y: number }> }>;
    dots: Set<string>;
    gates: Array<{
      id: string;
      a: { x: number; y: number };
      b: { x: number; y: number };
      switchA: { x: number; y: number };
      switchB: { x: number; y: number };
      open: boolean;
      permanent: boolean;
    }>;
    powerPellets: Map<
      string,
      {
        key: string;
        x: number;
        y: number;
        active: boolean;
        respawnAt: number;
      }
    >;
  };
  startedAtMs: number;
  step: (dtMs: number) => void;
  resolveGhostCollisions: (
    nowMs: number,
    playerPositionsBeforeMove: Map<string, { x: number; y: number }>,
    ghostPositionsBeforeMove: Map<string, { x: number; y: number }>,
  ) => void;
  updatePowerPellets: (nowMs: number) => void;
  isSafeRespawnCell: (cell: { x: number; y: number }, playerId: string) => boolean;
  isValidDotRespawnCell: (sectorId: number, x: number, y: number) => boolean;
  autoRespawn: (player: any, nowMs: number) => void;
}

function createEngine(seed: number): TestEngine {
  const players: StartPlayer[] = [
    {
      id: 'p1',
      name: 'P1',
      reconnectToken: 'token_p1',
      connected: true,
    },
  ];
  return new GameEngine(players, 'normal', seed, { timeLimitMsOverride: 180_000 }) as unknown as TestEngine;
}

function keepSingleGhost(engine: TestEngine): any {
  const firstGhost = engine.ghosts.values().next().value;
  assert.ok(firstGhost);
  for (const ghost of Array.from(engine.ghosts.values())) {
    if (ghost.id !== firstGhost.id) {
      engine.ghosts.delete(ghost.id);
    }
  }
  return firstGhost;
}

function findBaselineRespawnCell(engine: TestEngine, sectorId: number): { x: number; y: number } {
  const sector = engine.world.sectors.find((item) => item.id === sectorId);
  assert.ok(sector);

  for (const cell of sector.floorCells) {
    const key = keyOf(cell.x, cell.y);
    const hadDot = engine.world.dots.delete(key);
    const pellet = engine.world.powerPellets.get(key);
    if (pellet) {
      engine.world.powerPellets.delete(key);
    }

    const isValid = engine.isValidDotRespawnCell(sectorId, cell.x, cell.y);

    if (hadDot) {
      engine.world.dots.add(key);
    }
    if (pellet) {
      engine.world.powerPellets.set(key, pellet);
    }

    if (isValid) {
      return { x: cell.x, y: cell.y };
    }
  }

  throw new Error('No baseline respawn cell found');
}

function prepareCellAsRespawnCandidate(engine: TestEngine, cell: { x: number; y: number }): void {
  const key = keyOf(cell.x, cell.y);
  engine.world.dots.delete(key);
  engine.world.powerPellets.delete(key);
}

function testSwapCollision(): void {
  const engine = createEngine(11);
  const player = engine.players.get('p1');
  assert.ok(player);
  const firstGhost = keepSingleGhost(engine);

  player.state = 'normal';
  player.remoteReviveGraceUntil = 0;
  player.downSince = null;

  // Negative case: no overlap/swap should keep player alive.
  player.x = 20;
  player.y = 20;
  firstGhost.x = 24;
  firstGhost.y = 20;
  engine.resolveGhostCollisions(
    engine.startedAtMs + 500,
    new Map([[player.id, { x: 20, y: 20 }]]),
    new Map([[firstGhost.id, { x: 24, y: 20 }]]),
  );
  assert.equal(player.state, 'normal');

  // Positive case: swap positions in one tick should down the player.
  const playerBefore = { x: 10, y: 10 };
  const ghostBefore = { x: 11, y: 10 };
  player.x = 11;
  player.y = 10;
  firstGhost.x = 10;
  firstGhost.y = 10;

  engine.resolveGhostCollisions(
    engine.startedAtMs + 1000,
    new Map([[player.id, playerBefore]]),
    new Map([[firstGhost.id, ghostBefore]]),
  );

  assert.equal(player.state, 'down');
}

function testRespawnCellValidation(): void {
  // Gate exclusion
  {
    const engine = createEngine(13);
    const sector = engine.world.sectors[0];
    assert.ok(sector);
    const cell = findBaselineRespawnCell(engine, sector.id);
    prepareCellAsRespawnCandidate(engine, cell);
    assert.equal(engine.isValidDotRespawnCell(sector.id, cell.x, cell.y), true);

    engine.world.gates.push({
      id: 'gate_test',
      a: { x: cell.x, y: cell.y },
      b: { x: cell.x, y: cell.y },
      switchA: { x: cell.x, y: cell.y },
      switchB: { x: cell.x, y: cell.y },
      open: false,
      permanent: false,
    });
    assert.equal(engine.isValidDotRespawnCell(sector.id, cell.x, cell.y), false);
  }

  // Switch exclusion
  {
    const engine = createEngine(14);
    const sector = engine.world.sectors[0];
    assert.ok(sector);
    const cell = findBaselineRespawnCell(engine, sector.id);
    prepareCellAsRespawnCandidate(engine, cell);
    assert.equal(engine.isValidDotRespawnCell(sector.id, cell.x, cell.y), true);

    engine.world.gates.push({
      id: 'switch_test',
      a: { x: 0, y: 0 },
      b: { x: 0, y: 0 },
      switchA: { x: cell.x, y: cell.y },
      switchB: { x: 0, y: 0 },
      open: false,
      permanent: false,
    });
    assert.equal(engine.isValidDotRespawnCell(sector.id, cell.x, cell.y), false);
  }

  // Pellet exclusion
  {
    const engine = createEngine(15);
    const sector = engine.world.sectors[0];
    assert.ok(sector);
    const cell = findBaselineRespawnCell(engine, sector.id);
    prepareCellAsRespawnCandidate(engine, cell);
    assert.equal(engine.isValidDotRespawnCell(sector.id, cell.x, cell.y), true);

    const pelletKey = keyOf(cell.x, cell.y);
    engine.world.powerPellets.set(pelletKey, {
      key: pelletKey,
      x: cell.x,
      y: cell.y,
      active: true,
      respawnAt: 0,
    });
    assert.equal(engine.isValidDotRespawnCell(sector.id, cell.x, cell.y), false);
  }
}

function testPowerPelletRespawnValidation(): void {
  {
    const engine = createEngine(16);
    const sector = engine.world.sectors[0];
    assert.ok(sector);
    const cell = findBaselineRespawnCell(engine, sector.id);
    const key = keyOf(cell.x, cell.y);

    engine.world.powerPellets.set(key, {
      key,
      x: cell.x,
      y: cell.y,
      active: false,
      respawnAt: engine.startedAtMs - 1,
    });
    engine.updatePowerPellets(engine.startedAtMs);
    assert.equal(engine.world.powerPellets.get(key)?.active, true);
  }

  {
    const engine = createEngine(17);
    const sector = engine.world.sectors[0];
    assert.ok(sector);
    const cell = findBaselineRespawnCell(engine, sector.id);
    const key = keyOf(cell.x, cell.y);

    engine.world.gates.push({
      id: 'pellet_gate_test',
      a: { x: cell.x, y: cell.y },
      b: { x: cell.x, y: cell.y },
      switchA: { x: cell.x, y: cell.y },
      switchB: { x: cell.x, y: cell.y },
      open: false,
      permanent: false,
    });
    engine.world.powerPellets.set(key, {
      key,
      x: cell.x,
      y: cell.y,
      active: false,
      respawnAt: engine.startedAtMs - 1,
    });

    engine.updatePowerPellets(engine.startedAtMs);
    assert.equal(engine.world.powerPellets.get(key)?.active, false);
    assert.ok((engine.world.powerPellets.get(key)?.respawnAt ?? 0) > engine.startedAtMs);
  }
}

function testSafeRespawnCellValidation(): void {
  const engine = createEngine(18);
  const sector = engine.world.sectors[0];
  assert.ok(sector);
  const cell = findBaselineRespawnCell(engine, sector.id);

  engine.ghosts.clear();
  assert.equal(engine.isSafeRespawnCell(cell, 'p1'), true);

  engine.world.gates.push({
    id: 'safe_respawn_gate_test',
    a: { x: cell.x, y: cell.y },
    b: { x: cell.x, y: cell.y },
    switchA: { x: cell.x, y: cell.y },
    switchB: { x: cell.x, y: cell.y },
    open: false,
    permanent: false,
  });
  assert.equal(engine.isSafeRespawnCell(cell, 'p1'), false);
}

function testAutoRespawnGrace(): void {
  const engine = createEngine(19);
  const player = engine.players.get('p1');
  assert.ok(player);
  const firstGhost = keepSingleGhost(engine);

  const nowMs = engine.startedAtMs + 20_000;
  player.state = 'down';
  player.downSince = nowMs - 10_000;
  player.remoteReviveGraceUntil = 0;

  engine.autoRespawn(player, nowMs);

  assert.equal(player.state, 'normal');
  assert.ok(player.remoteReviveGraceUntil > nowMs);

  firstGhost.x = player.x;
  firstGhost.y = player.y;
  engine.resolveGhostCollisions(
    nowMs + 1_000,
    new Map([[player.id, { x: player.x, y: player.y }]]),
    new Map([[firstGhost.id, { x: firstGhost.x, y: firstGhost.y }]]),
  );
  assert.equal(player.state, 'normal');

  engine.resolveGhostCollisions(
    nowMs + 2_500,
    new Map([[player.id, { x: player.x, y: player.y }]]),
    new Map([[firstGhost.id, { x: firstGhost.x, y: firstGhost.y }]]),
  );
  assert.equal(player.state, 'down');
}

function testStepCollisionIntegration(): void {
  const engine = createEngine(21);
  const player = engine.players.get('p1');
  assert.ok(player);
  const ghost = keepSingleGhost(engine);

  player.state = 'normal';
  player.remoteReviveGraceUntil = 0;
  player.downSince = null;
  player.moveBuffer = 0;
  player.desiredDir = 'none';
  player.dir = 'none';

  player.x = ghost.x;
  player.y = ghost.y;

  engine.step(0);
  assert.equal(player.state, 'down');
}

function testStepAutoRespawnIntegration(): void {
  const engine = createEngine(23);
  const player = engine.players.get('p1');
  assert.ok(player);

  player.state = 'down';
  player.downSince = engine.startedAtMs - 100_000;
  player.remoteReviveGraceUntil = 0;

  engine.step(0);
  assert.equal(player.state, 'normal');
  assert.ok(player.remoteReviveGraceUntil > engine.startedAtMs);
}

function run(): void {
  testSwapCollision();
  testRespawnCellValidation();
  testPowerPelletRespawnValidation();
  testSafeRespawnCellValidation();
  testAutoRespawnGrace();
  testStepCollisionIntegration();
  testStepAutoRespawnIntegration();
  console.log('server game selftest: OK');
}

run();
