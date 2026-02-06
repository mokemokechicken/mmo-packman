import assert from 'node:assert/strict';
import { resolveLoopProgress } from './loop.js';

function run(): void {
  const basic = resolveLoopProgress({
    accumulatorMs: 0,
    deltaMs: 60,
    tickMs: 50,
    maxSteps: 5,
    maxDeltaMs: 1_000,
  });
  assert.equal(basic.steps, 1);
  assert.equal(basic.accumulatorMs, 10);

  const cappedBySteps = resolveLoopProgress({
    accumulatorMs: 0,
    deltaMs: 300,
    tickMs: 50,
    maxSteps: 5,
    maxDeltaMs: 1_000,
  });
  assert.equal(cappedBySteps.steps, 5);
  assert.equal(cappedBySteps.accumulatorMs, 0);
  assert.equal(cappedBySteps.droppedBacklogMs, 50);

  const cappedByDelta = resolveLoopProgress({
    accumulatorMs: 0,
    deltaMs: 5_000,
    tickMs: 50,
    maxSteps: 50,
    maxDeltaMs: 1_000,
  });
  assert.equal(cappedByDelta.clampedDeltaMs, 1_000);
  assert.equal(cappedByDelta.steps, 20);
  assert.equal(cappedByDelta.accumulatorMs, 0);

  const negativeDelta = resolveLoopProgress({
    accumulatorMs: 10,
    deltaMs: -100,
    tickMs: 50,
    maxSteps: 5,
    maxDeltaMs: 1_000,
  });
  assert.equal(negativeDelta.steps, 0);
  assert.equal(negativeDelta.accumulatorMs, 10);

  console.log('server loop selftest: OK');
}

run();
