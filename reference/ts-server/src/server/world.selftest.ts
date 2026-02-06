import assert from 'node:assert/strict';
import { buildGateSwitchCellSet } from './gate_utils.js';
import { keyOf } from './helpers.js';
import { generateWorld } from './world.js';

function testGateSwitchCellsAreExcludedFromSpawnables(): void {
  const playerCounts = [2, 5, 20];
  const seeds = [11, 17, 23, 29, 31];

  for (const playerCount of playerCounts) {
    for (const seed of seeds) {
      const world = generateWorld(playerCount, seed);
      const gateSwitchCells = buildGateSwitchCellSet(world.gates);

      for (const key of gateSwitchCells) {
        assert.equal(world.dots.has(key), false);
        assert.equal(world.powerPellets.has(key), false);
      }

      for (const sector of world.sectors) {
        for (const cell of sector.respawnCandidates) {
          assert.equal(gateSwitchCells.has(keyOf(cell.x, cell.y)), false);
        }
      }
    }
  }
}

function run(): void {
  testGateSwitchCellsAreExcludedFromSpawnables();
  console.log('world selftest: OK');
}

run();
