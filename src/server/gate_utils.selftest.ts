import assert from 'node:assert/strict';
import type { GateState } from '../shared/types.js';
import { keyOf } from './helpers.js';
import {
  buildGateSwitchCellSet,
  isGateCellOrSwitch,
} from './gate_utils.js';

function createGates(): GateState[] {
  return [
    {
      id: 'g1',
      a: { x: 1, y: 1 },
      b: { x: 2, y: 1 },
      switchA: { x: 1, y: 2 },
      switchB: { x: 2, y: 2 },
      open: false,
      permanent: false,
    },
    {
      id: 'g2',
      a: { x: 10, y: 5 },
      b: { x: 11, y: 5 },
      switchA: { x: 10, y: 6 },
      switchB: { x: 11, y: 6 },
      open: true,
      permanent: false,
    },
  ];
}

function run(): void {
  const gates = createGates();
  const gateSwitchCells = buildGateSwitchCellSet(gates);
  assert.equal(gateSwitchCells.size, 8);

  const expectedKeys = [
    keyOf(1, 1),
    keyOf(2, 1),
    keyOf(1, 2),
    keyOf(2, 2),
    keyOf(10, 5),
    keyOf(11, 5),
    keyOf(10, 6),
    keyOf(11, 6),
  ];

  for (const key of expectedKeys) {
    assert.equal(gateSwitchCells.has(key), true);
  }

  assert.equal(isGateCellOrSwitch(gates, 1, 1), true);
  assert.equal(isGateCellOrSwitch(gates, 2, 2), true);
  assert.equal(isGateCellOrSwitch(gates, 11, 6), true);
  assert.equal(isGateCellOrSwitch(gates, 0, 0), false);

  assert.equal(isGateCellOrSwitch(gates, 1, 1, gateSwitchCells), true);
  assert.equal(isGateCellOrSwitch(gates, 2, 2, gateSwitchCells), true);
  assert.equal(isGateCellOrSwitch(gates, 11, 6, gateSwitchCells), true);
  assert.equal(isGateCellOrSwitch(gates, 0, 0, gateSwitchCells), false);

  console.log('gate utils selftest: OK');
}

run();
