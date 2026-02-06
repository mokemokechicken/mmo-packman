import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Difficulty } from '../shared/types.js';

export interface ScenarioResultLine {
  scenario: string;
  seed: number;
  aiPlayers: number;
  minutes: number;
  difficulty: Difficulty;
  reason: string;
  maxCapture: number;
  minCaptureAfter70: number;
  dotEaten: number;
  dotRespawned: number;
  downs: number;
  rescues: number;
  sectorCaptured: number;
  sectorLost: number;
  bossSpawned: number;
  bossHits: number;
  anomalies: string[];
}

export interface HarnessOptions {
  ai: number;
  minutes: number;
  difficulty: Difficulty;
  seeds: number[];
  captureTolerance: number;
  reportFile: string | null;
}

interface EngineRunResult {
  line: ScenarioResultLine;
  commandText: string;
}

interface ParityFailure {
  seed: number;
  aiPlayers: number;
  minutes: number;
  difficulty: Difficulty;
  differences: string[];
  ts: ScenarioResultLine | null;
  rust: ScenarioResultLine | null;
  commands: {
    ts: string;
    rust: string;
  };
  executionError?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const difficultyValues: Difficulty[] = ['casual', 'normal', 'hard', 'nightmare'];
const MAX_U32 = 4_294_967_295;

function main(): void {
  const options = resolveOptions(process.argv.slice(2));
  const failures: ParityFailure[] = [];

  for (const seed of options.seeds) {
    try {
      const tsRun = runSimulator('simulate', options, seed);
      const rustRun = runSimulator('simulate:rust', options, seed);
      const differences = compareResults(tsRun.line, rustRun.line, options.captureTolerance);

      if (differences.length === 0) {
        console.log(`[parity] seed=${seed} OK`);
        continue;
      }

      failures.push({
        seed,
        aiPlayers: options.ai,
        minutes: options.minutes,
        difficulty: options.difficulty,
        differences,
        ts: tsRun.line,
        rust: rustRun.line,
        commands: {
          ts: tsRun.commandText,
          rust: rustRun.commandText,
        },
      });
      console.error(`[parity] seed=${seed} NG (${differences.length} differences)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const commands = buildCommandTexts(options, seed);
      failures.push({
        seed,
        aiPlayers: options.ai,
        minutes: options.minutes,
        difficulty: options.difficulty,
        differences: [`execution_error: ${message}`],
        ts: null,
        rust: null,
        commands,
        executionError: message,
      });
      console.error(`[parity] seed=${seed} ERROR`);
    }
  }

  const report = {
    totalSeeds: options.seeds.length,
    failedSeeds: failures.length,
    options: {
      ai: options.ai,
      minutes: options.minutes,
      difficulty: options.difficulty,
      captureTolerance: options.captureTolerance,
      seeds: options.seeds,
    },
    failures,
  };

  if (options.reportFile) {
    writeFileSync(options.reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`[parity] wrote report: ${options.reportFile}`);
  }

  if (failures.length > 0) {
    console.error(`[parity] FAILED ${failures.length}/${options.seeds.length} seeds.`);
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(`[parity] PASSED ${options.seeds.length}/${options.seeds.length} seeds.`);
}

function runSimulator(scriptName: 'simulate' | 'simulate:rust', options: HarnessOptions, seed: number): EngineRunResult {
  const args = buildNpmArgs(scriptName, options, seed);
  const commandText = `npm ${args.join(' ')}`;
  const result = spawnSync('npm', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`[parity] failed to execute ${commandText}: ${result.error.message}`);
  }
  if (!result.stdout) {
    throw new Error(`[parity] ${commandText} produced no stdout`);
  }
  const status = result.status;
  if (status === null) {
    throw new Error(`[parity] ${commandText} exited without status (signal=${result.signal ?? 'unknown'})`);
  }

  let line: ScenarioResultLine;
  try {
    line = extractResultLine(result.stdout, commandText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[parity] failed to parse output from ${commandText}\nstdout:\n${tail(result.stdout)}\nstderr:\n${tail(result.stderr)}\n${message}`
    );
  }

  if (!isExpectedSimulatorExitStatus(status, line.anomalies.length)) {
    throw new Error(
      `[parity] ${commandText} exited with unexpected code ${status} (anomalies=${line.anomalies.length})\nstdout:\n${tail(result.stdout)}\nstderr:\n${tail(result.stderr)}`
    );
  }

  return {
    line,
    commandText,
  };
}

function buildNpmArgs(scriptName: 'simulate' | 'simulate:rust', options: HarnessOptions, seed: number): string[] {
  return [
    'run',
    scriptName,
    '--',
    '--single',
    '--ai',
    `${options.ai}`,
    '--minutes',
    `${options.minutes}`,
    '--difficulty',
    options.difficulty,
    '--seed',
    `${seed}`,
  ];
}

function buildCommandTexts(options: HarnessOptions, seed: number): { ts: string; rust: string } {
  return {
    ts: `npm ${buildNpmArgs('simulate', options, seed).join(' ')}`,
    rust: `npm ${buildNpmArgs('simulate:rust', options, seed).join(' ')}`,
  };
}

export function isExpectedSimulatorExitStatus(status: number, anomalyCount: number): boolean {
  return status === 0 || (status === 1 && anomalyCount > 0);
}

export function extractResultLine(stdout: string, commandText: string): ScenarioResultLine {
  const parsed: ScenarioResultLine[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{') || !line.endsWith('}')) {
      continue;
    }
    try {
      const value = JSON.parse(line) as unknown;
      if (isScenarioResultLine(value)) {
        parsed.push(value);
      }
    } catch {
      // Ignore non-JSON noise lines.
    }
  }

  if (parsed.length !== 1) {
    throw new Error(
      `[parity] expected exactly 1 JSON result line from ${commandText}, got ${parsed.length}\nstdout:\n${tail(stdout)}`
    );
  }

  return parsed[0];
}

function isScenarioResultLine(value: unknown): value is ScenarioResultLine {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.scenario === 'string' &&
    typeof v.seed === 'number' &&
    typeof v.aiPlayers === 'number' &&
    typeof v.minutes === 'number' &&
    typeof v.difficulty === 'string' &&
    isDifficulty(v.difficulty) &&
    typeof v.reason === 'string' &&
    typeof v.maxCapture === 'number' &&
    typeof v.minCaptureAfter70 === 'number' &&
    typeof v.dotEaten === 'number' &&
    typeof v.dotRespawned === 'number' &&
    typeof v.downs === 'number' &&
    typeof v.rescues === 'number' &&
    typeof v.sectorCaptured === 'number' &&
    typeof v.sectorLost === 'number' &&
    typeof v.bossSpawned === 'number' &&
    typeof v.bossHits === 'number' &&
    Array.isArray(v.anomalies) &&
    v.anomalies.every((item) => typeof item === 'string')
  );
}

export function compareResults(ts: ScenarioResultLine, rust: ScenarioResultLine, captureTolerance: number): string[] {
  const diffs: string[] = [];
  const exactKeys: Array<keyof ScenarioResultLine> = [
    'reason',
    'dotEaten',
    'dotRespawned',
    'downs',
    'rescues',
    'sectorCaptured',
    'sectorLost',
    'bossSpawned',
    'bossHits',
  ];

  for (const key of exactKeys) {
    if (ts[key] !== rust[key]) {
      diffs.push(`${key}: ts=${String(ts[key])}, rust=${String(rust[key])}`);
    }
  }

  if (ts.anomalies.length !== rust.anomalies.length) {
    diffs.push(`anomalies.length: ts=${ts.anomalies.length}, rust=${rust.anomalies.length}`);
  }

  compareCaptureValue('maxCapture', ts.maxCapture, rust.maxCapture, captureTolerance, diffs);
  compareCaptureValue('minCaptureAfter70', ts.minCaptureAfter70, rust.minCaptureAfter70, captureTolerance, diffs);

  return diffs;
}

function compareCaptureValue(
  name: 'maxCapture' | 'minCaptureAfter70',
  ts: number,
  rust: number,
  tolerance: number,
  diffs: string[]
): void {
  const delta = Math.abs(ts - rust);
  if (delta > tolerance) {
    diffs.push(`${name}: ts=${ts}, rust=${rust}, delta=${delta.toFixed(3)} > tolerance(${tolerance})`);
  }
}

export function resolveOptions(args: string[]): HarnessOptions {
  const ai = clamp(readArgNumber(args, '--ai') ?? 5, 1, 100);
  const minutes = clamp(readArgNumber(args, '--minutes') ?? 3, 1, 10);
  const difficulty = readDifficulty(args, '--difficulty') ?? 'normal';
  const captureTolerance = readArgNumber(args, '--capture-tolerance') ?? 0.2;
  const reportFile = readArgString(args, '--report-file');

  const explicitSeeds = readArgString(args, '--seeds');
  const seeds = explicitSeeds
    ? parseSeedList(explicitSeeds)
    : buildSeedRange(
        normalizeSeed(readArgNumber(args, '--seed-start') ?? 1001),
        clamp(readArgNumber(args, '--seed-count') ?? 10, 1, 100)
      );

  if (captureTolerance < 0) {
    throw new Error('--capture-tolerance must be >= 0');
  }

  return {
    ai,
    minutes,
    difficulty,
    seeds,
    captureTolerance,
    reportFile,
  };
}

function parseSeedList(raw: string): number[] {
  const seeds = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => Number(token));
  if (seeds.length === 0 || seeds.some((seed) => !Number.isFinite(seed))) {
    throw new Error('--seeds must contain comma-separated numbers');
  }
  return seeds.map((seed) => normalizeSeed(seed));
}

function buildSeedRange(seedStart: number, seedCount: number): number[] {
  return Array.from({ length: seedCount }, (_, index) => normalizeSeed(seedStart + index));
}

function readArgNumber(args: string[], name: string): number | null {
  const idx = args.indexOf(name);
  if (idx < 0) {
    return null;
  }
  if (idx + 1 >= args.length) {
    throw new Error(`${name} requires a value`);
  }
  const raw = args[idx + 1] ?? '';
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number (received: ${raw})`);
  }
  return parsed;
}

function readArgString(args: string[], name: string): string | null {
  const idx = args.indexOf(name);
  if (idx < 0) {
    return null;
  }
  if (idx + 1 >= args.length) {
    throw new Error(`${name} requires a value`);
  }
  const value = args[idx + 1];
  return value ? value : null;
}

function readDifficulty(args: string[], name: string): Difficulty | null {
  const value = readArgString(args, name);
  if (value === null) {
    return null;
  }
  if (!isDifficulty(value)) {
    throw new Error(`${name} must be one of: ${difficultyValues.join(', ')}`);
  }
  return value;
}

function isDifficulty(value: string): value is Difficulty {
  return difficultyValues.includes(value as Difficulty);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function normalizeSeed(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`seed must be an integer (received: ${value})`);
  }
  if (value < 0 || value > MAX_U32) {
    throw new Error(`seed must be in range [0, ${MAX_U32}] (received: ${value})`);
  }
  return value;
}

function tail(value: string, lineCount = 40): string {
  const lines = value.trim().split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - lineCount)).join('\n');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
