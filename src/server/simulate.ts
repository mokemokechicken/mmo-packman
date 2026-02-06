import { randomUUID } from 'node:crypto';
import { TICK_MS } from '../shared/constants.js';
import type { Difficulty, Snapshot } from '../shared/types.js';
import { GameEngine, type StartPlayer } from './game.js';

interface Scenario {
  name: string;
  aiPlayers: number;
  minutes: number;
  difficulty: Difficulty;
}

interface ScenarioResult {
  scenario: Scenario;
  ticks: number;
  ended: boolean;
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

const scenarios = resolveScenarios(process.argv.slice(2));
const results: ScenarioResult[] = [];

for (const scenario of scenarios) {
  const result = runScenario(scenario);
  results.push(result);
  printScenarioResult(result);
}

const hasAnomaly = results.some((result) => result.anomalies.length > 0);
if (hasAnomaly) {
  process.exitCode = 1;
}

function runScenario(scenario: Scenario): ScenarioResult {
  const startPlayers: StartPlayer[] = Array.from({ length: scenario.aiPlayers }, (_, idx) => ({
    id: `ai_${idx + 1}`,
    name: `AI-${(idx + 1).toString().padStart(2, '0')}`,
    reconnectToken: randomUUID(),
    connected: false,
  }));

  const engine = new GameEngine(startPlayers, scenario.difficulty, Date.now(), {
    timeLimitMsOverride: scenario.minutes * 60_000,
  });

  let ticks = 0;
  let maxCapture = 0;
  let minCaptureAfter70 = 1;
  let crossed70 = false;
  let dotEaten = 0;
  let dotRespawned = 0;
  let downs = 0;
  let rescues = 0;
  let sectorCaptured = 0;
  let sectorLost = 0;
  let bossSpawned = 0;
  let bossHits = 0;
  const anomalies: string[] = [];

  while (!engine.isEnded()) {
    engine.step(TICK_MS);
    ticks += 1;

    const snapshot = engine.buildSnapshot(true);
    validateSnapshot(snapshot, anomalies);

    maxCapture = Math.max(maxCapture, snapshot.captureRatio);
    if (snapshot.captureRatio >= 0.7) {
      crossed70 = true;
    }
    if (crossed70) {
      minCaptureAfter70 = Math.min(minCaptureAfter70, snapshot.captureRatio);
    }

    for (const event of snapshot.events) {
      if (event.type === 'dot_eaten') {
        dotEaten += 1;
      } else if (event.type === 'dot_respawned') {
        dotRespawned += 1;
      } else if (event.type === 'player_down') {
        downs += 1;
      } else if (event.type === 'player_revived') {
        rescues += 1;
      } else if (event.type === 'sector_captured') {
        sectorCaptured += 1;
      } else if (event.type === 'sector_lost') {
        sectorLost += 1;
      } else if (event.type === 'boss_spawned') {
        bossSpawned += 1;
      } else if (event.type === 'boss_hit') {
        bossHits += 1;
      }
    }
  }

  const summary = engine.buildSummary();

  if (crossed70 && minCaptureAfter70 <= 0.2) {
    anomalies.push(
      `capture collapse: reached >=70% but dropped to ${(minCaptureAfter70 * 100).toFixed(1)}%`,
    );
  }

  return {
    scenario,
    ticks,
    ended: engine.isEnded(),
    reason: summary.reason,
    maxCapture,
    minCaptureAfter70: crossed70 ? minCaptureAfter70 : 1,
    dotEaten,
    dotRespawned,
    downs,
    rescues,
    sectorCaptured,
    sectorLost,
    bossSpawned,
    bossHits,
    anomalies,
  };
}

function validateSnapshot(snapshot: Snapshot, anomalies: string[]): void {
  const width = snapshot.sectors.length > 0 ? snapshot.sectors[0]?.size ?? 17 : 17;
  const totalDots = snapshot.sectors.reduce((sum, sector) => sum + sector.dotCount, 0);

  if (!Number.isFinite(snapshot.captureRatio) || snapshot.captureRatio < 0 || snapshot.captureRatio > 1) {
    anomalies.push(`invalid capture ratio: ${snapshot.captureRatio}`);
  }
  if (totalDots < 0) {
    anomalies.push(`negative total dots: ${totalDots}`);
  }

  for (const player of snapshot.players) {
    if (!Number.isFinite(player.x) || !Number.isFinite(player.y)) {
      anomalies.push(`player NaN position: ${player.id}`);
    }
    if (player.gauge < 0 || player.gauge > player.gaugeMax) {
      anomalies.push(`player gauge out of range: ${player.id} ${player.gauge}/${player.gaugeMax}`);
    }
  }

  for (const ghost of snapshot.ghosts) {
    if (!Number.isFinite(ghost.x) || !Number.isFinite(ghost.y)) {
      anomalies.push(`ghost NaN position: ${ghost.id}`);
    }
    if (ghost.hp <= 0) {
      anomalies.push(`ghost hp <= 0 remains: ${ghost.id}`);
    }
  }

  // Sanity check for empty world evolution
  if (snapshot.sectors.length === 0 || width <= 0) {
    anomalies.push('invalid sector configuration');
  }
}

function printScenarioResult(result: ScenarioResult): void {
  const line = {
    scenario: result.scenario.name,
    aiPlayers: result.scenario.aiPlayers,
    minutes: result.scenario.minutes,
    difficulty: result.scenario.difficulty,
    reason: result.reason,
    maxCapture: Number((result.maxCapture * 100).toFixed(1)),
    minCaptureAfter70: Number((result.minCaptureAfter70 * 100).toFixed(1)),
    dotEaten: result.dotEaten,
    dotRespawned: result.dotRespawned,
    downs: result.downs,
    rescues: result.rescues,
    sectorCaptured: result.sectorCaptured,
    sectorLost: result.sectorLost,
    bossSpawned: result.bossSpawned,
    bossHits: result.bossHits,
    anomalies: result.anomalies,
  };

  console.log(JSON.stringify(line));
}

function resolveScenarios(args: string[]): Scenario[] {
  const ai = readArgNumber(args, '--ai');
  const minutes = readArgNumber(args, '--minutes');
  const difficulty = (readArgString(args, '--difficulty') as Difficulty | null) ?? 'normal';

  if (ai !== null || minutes !== null || args.includes('--single')) {
    return [
      {
        name: `custom-ai${ai ?? 2}`,
        aiPlayers: clamp(ai ?? 2, 1, 100),
        minutes: clamp(minutes ?? 3, 1, 10),
        difficulty,
      },
    ];
  }

  return [
    { name: 'quick-check-ai2', aiPlayers: 2, minutes: 2, difficulty: 'normal' },
    { name: 'balance-check-ai5', aiPlayers: 5, minutes: 5, difficulty: 'normal' },
  ];
}

function readArgNumber(args: string[], name: string): number | null {
  const idx = args.indexOf(name);
  if (idx < 0 || idx + 1 >= args.length) {
    return null;
  }
  const value = Number(args[idx + 1]);
  return Number.isFinite(value) ? value : null;
}

function readArgString(args: string[], name: string): string | null {
  const idx = args.indexOf(name);
  if (idx < 0 || idx + 1 >= args.length) {
    return null;
  }
  return args[idx + 1] ?? null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
