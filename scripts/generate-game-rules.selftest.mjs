import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildOutputs,
  validateConfig,
  verifyGeneratedFiles,
  writeGeneratedFiles,
} from './generate-game-rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'config/game_rules.json');

const config = JSON.parse(await readFile(configPath, 'utf8'));
validateConfig(config);

const outputs = buildOutputs(config);
assert.match(outputs.ts, /export const TICK_RATE = 20;/);
assert.match(outputs.rust, /pub const TICK_RATE: u32 = 20;/);

const cloneConfig = () => JSON.parse(JSON.stringify(config));

const invalidOrderConfig = cloneConfig();
invalidOrderConfig.mapSideByPlayers[1].maxPlayers = invalidOrderConfig.mapSideByPlayers[0].maxPlayers;
assert.throws(() => validateConfig(invalidOrderConfig), /strictly ascending/);

const invalidTypeConfig = cloneConfig();
invalidTypeConfig.tickRate = '20';
assert.throws(() => validateConfig(invalidTypeConfig), /finite number/);

const invalidSafeIntegerConfig = cloneConfig();
invalidSafeIntegerConfig.timeLimitMsDefault = Number.MAX_SAFE_INTEGER + 1;
assert.throws(() => validateConfig(invalidSafeIntegerConfig), /safe integer/);

const invalidCaptureConfig = cloneConfig();
invalidCaptureConfig.capturePressure[0].maxCaptureRatio = 1.1;
assert.throws(() => validateConfig(invalidCaptureConfig), /must be <= 1/);

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'game-rules-'));
const tsPath = path.join(tempDir, 'constants.ts');
const rsPath = path.join(tempDir, 'constants.rs');

await writeGeneratedFiles(outputs, { tsPath, rsPath });
await verifyGeneratedFiles(outputs, { tsPath, rsPath });

await writeFile(tsPath, `${outputs.ts}\n// drift\n`, 'utf8');
await assert.rejects(
  () => verifyGeneratedFiles(outputs, { tsPath, rsPath }),
  /out of date/
);

await writeFile(tsPath, outputs.ts, 'utf8');
await writeFile(rsPath, `${outputs.rust}\n// drift\n`, 'utf8');
await assert.rejects(
  () => verifyGeneratedFiles(outputs, { tsPath, rsPath }),
  /out of date/
);

console.log('generate-game-rules selftest: OK');
