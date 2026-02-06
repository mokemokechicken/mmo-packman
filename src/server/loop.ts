export interface LoopProgressInput {
  accumulatorMs: number;
  deltaMs: number;
  tickMs: number;
  maxSteps: number;
  maxDeltaMs: number;
}

export interface LoopProgressOutput {
  steps: number;
  accumulatorMs: number;
  clampedDeltaMs: number;
  droppedBacklogMs: number;
}

export function resolveLoopProgress(input: LoopProgressInput): LoopProgressOutput {
  const clampedDeltaMs = Math.max(0, Math.min(input.maxDeltaMs, input.deltaMs));
  let accumulatorMs = input.accumulatorMs + clampedDeltaMs;
  let steps = 0;

  while (accumulatorMs >= input.tickMs && steps < input.maxSteps) {
    accumulatorMs -= input.tickMs;
    steps += 1;
  }

  let droppedBacklogMs = 0;
  if (steps === input.maxSteps && accumulatorMs >= input.tickMs) {
    const retainedMs = accumulatorMs % input.tickMs;
    droppedBacklogMs = accumulatorMs - retainedMs;
    accumulatorMs = retainedMs;
  }

  return {
    steps,
    accumulatorMs,
    clampedDeltaMs,
    droppedBacklogMs,
  };
}
