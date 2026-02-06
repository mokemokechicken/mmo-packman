import type { GateState } from '../shared/types.js';
import { keyOf } from './helpers.js';

export function buildGateSwitchCellSet(gates: GateState[]): Set<string> {
  const cellSet = new Set<string>();
  for (const gate of gates) {
    cellSet.add(keyOf(gate.a.x, gate.a.y));
    cellSet.add(keyOf(gate.b.x, gate.b.y));
    cellSet.add(keyOf(gate.switchA.x, gate.switchA.y));
    cellSet.add(keyOf(gate.switchB.x, gate.switchB.y));
  }
  return cellSet;
}

export function isGateCellOrSwitch(
  gates: GateState[],
  x: number,
  y: number,
  gateSwitchCells?: ReadonlySet<string>,
): boolean {
  if (gateSwitchCells) {
    return gateSwitchCells.has(keyOf(x, y));
  }
  for (const gate of gates) {
    if (
      (gate.a.x === x && gate.a.y === y) ||
      (gate.b.x === x && gate.b.y === y) ||
      (gate.switchA.x === x && gate.switchA.y === y) ||
      (gate.switchB.x === x && gate.switchB.y === y)
    ) {
      return true;
    }
  }
  return false;
}
