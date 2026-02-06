import assert from 'node:assert/strict';

import {
  compareResults,
  extractResultLine,
  isExpectedSimulatorExitStatus,
  normalizeSeed,
  resolveOptions,
  type ScenarioResultLine,
} from './parity_harness.js';

const base: ScenarioResultLine = {
  scenario: 'custom-ai5',
  seed: 1001,
  aiPlayers: 5,
  minutes: 3,
  difficulty: 'normal',
  reason: 'timeout',
  maxCapture: 25,
  minCaptureAfter70: 100,
  dotEaten: 300,
  dotRespawned: 0,
  downs: 2,
  rescues: 2,
  sectorCaptured: 0,
  sectorLost: 0,
  bossSpawned: 0,
  bossHits: 0,
  anomalies: [],
};

const metaDifferent: ScenarioResultLine = {
  ...base,
  scenario: 'custom-ai2',
  seed: 9999,
  aiPlayers: 2,
  minutes: 1,
  difficulty: 'hard',
};
assert.deepEqual(compareResults(base, metaDifferent, 0.2), []);

const reasonDifferent: ScenarioResultLine = {
  ...base,
  reason: 'all_down',
};
assert.deepEqual(compareResults(base, reasonDifferent, 0.2), ['reason: ts=timeout, rust=all_down']);

const output = `noise\n${JSON.stringify(base)}\n`;
assert.equal(extractResultLine(output, 'dummy').seed, base.seed);

assert.throws(
  () => extractResultLine(`${JSON.stringify(base)}\n${JSON.stringify(base)}\n`, 'dummy'),
  /expected exactly 1 JSON result line/
);

assert.equal(normalizeSeed(0), 0);
assert.equal(normalizeSeed(123), 123);
assert.throws(() => normalizeSeed(-1), /range/);
assert.throws(() => normalizeSeed(1.5), /integer/);

assert.equal(isExpectedSimulatorExitStatus(0, 0), true);
assert.equal(isExpectedSimulatorExitStatus(1, 2), true);
assert.equal(isExpectedSimulatorExitStatus(1, 0), false);
assert.equal(isExpectedSimulatorExitStatus(2, 3), false);

assert.equal(resolveOptions(['--seed-start', '10', '--seed-count', '2']).seeds.join(','), '10,11');
assert.throws(() => resolveOptions(['--capture-tolerance', 'abc']), /must be a number/);
assert.throws(() => resolveOptions(['--seed-start', '-1']), /range/);

console.log('parity harness selftest: OK');
