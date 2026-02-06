import {
  SECTOR_SIZE,
  getMapSideByPlayerCount,
} from '../shared/constants.js';
import type {
  GateState,
  SectorState,
  SectorType,
  Vec2,
  WorldInit,
} from '../shared/types.js';
import { keyOf, manhattan, makeId } from './helpers.js';
import { Rng } from './rng.js';

export interface PowerPelletInternal {
  key: string;
  x: number;
  y: number;
  active: boolean;
  respawnAt: number;
}

export interface SectorInternal extends SectorState {
  floorCells: Vec2[];
  respawnCandidates: Vec2[];
  capturedAt: number;
  regenAccumulator: number;
}

export interface GeneratedWorld {
  width: number;
  height: number;
  side: number;
  sectorSize: number;
  tiles: string[];
  sectors: SectorInternal[];
  gates: GateState[];
  dots: Set<string>;
  powerPellets: Map<string, PowerPelletInternal>;
  playerSpawnCells: Vec2[];
  ghostSpawnCells: Vec2[];
}

interface Connection {
  a: Vec2;
  b: Vec2;
  switchA: Vec2;
  switchB: Vec2;
}

const SECTOR_TYPES: SectorType[] = ['normal', 'narrow', 'plaza', 'dark', 'fast', 'nest'];

export function generateWorld(playerCount: number, seed = Date.now()): GeneratedWorld {
  const rng = new Rng(seed);
  const side = getMapSideByPlayerCount(Math.max(2, playerCount));
  const width = side * SECTOR_SIZE;
  const height = side * SECTOR_SIZE;

  const grid: string[][] = Array.from({ length: height }, () => Array.from({ length: width }, () => '#'));
  const sectors: SectorInternal[] = [];

  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      const id = row * side + col;
      const type = pickSectorType(row, col, side, rng);
      const local = buildSectorMaze(SECTOR_SIZE, type, rng);
      const x0 = col * SECTOR_SIZE;
      const y0 = row * SECTOR_SIZE;

      for (let y = 0; y < SECTOR_SIZE; y += 1) {
        for (let x = 0; x < SECTOR_SIZE; x += 1) {
          grid[y0 + y][x0 + x] = local[y][x];
        }
      }

      sectors.push({
        id,
        row,
        col,
        x: x0,
        y: y0,
        size: SECTOR_SIZE,
        type,
        discovered: false,
        captured: false,
        dotCount: 0,
        totalDots: 0,
        floorCells: [],
        respawnCandidates: [],
        capturedAt: 0,
        regenAccumulator: 0,
      });
    }
  }

  const gateChance = Math.min(0.32, Math.max(0.08, playerCount / 320));
  const gates: GateState[] = [];

  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      if (col < side - 1) {
        const conn = connectRight(grid, row, col, side, rng);
        if (conn && rng.bool(gateChance)) {
          setFloor(grid, conn.switchA.x, conn.switchA.y);
          setFloor(grid, conn.switchB.x, conn.switchB.y);
          gates.push({
            id: makeId('gate'),
            a: conn.a,
            b: conn.b,
            switchA: conn.switchA,
            switchB: conn.switchB,
            open: false,
            permanent: false,
          });
        }
      }
      if (row < side - 1) {
        const conn = connectDown(grid, row, col, side, rng);
        if (conn && rng.bool(gateChance)) {
          setFloor(grid, conn.switchA.x, conn.switchA.y);
          setFloor(grid, conn.switchB.x, conn.switchB.y);
          gates.push({
            id: makeId('gate'),
            a: conn.a,
            b: conn.b,
            switchA: conn.switchA,
            switchB: conn.switchB,
            open: false,
            permanent: false,
          });
        }
      }
    }
  }

  const powerPellets = new Map<string, PowerPelletInternal>();
  const pelletKeys = new Set<string>();

  for (const sector of sectors) {
    scanSectorFloorCells(grid, sector);
    const pellets = placeSectorPowerPellets(grid, sector, rng);
    for (const pos of pellets) {
      const key = keyOf(pos.x, pos.y);
      pelletKeys.add(key);
      powerPellets.set(key, {
        key,
        x: pos.x,
        y: pos.y,
        active: true,
        respawnAt: 0,
      });
    }
  }

  const playerSpawnCells = collectPlayerSpawns(sectors, grid, side);
  const ghostSpawnCells = collectGhostSpawns(sectors, grid, side);

  const spawnProtected = new Set<string>();
  for (const spawn of playerSpawnCells) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const x = spawn.x + dx;
        const y = spawn.y + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) {
          continue;
        }
        spawnProtected.add(keyOf(x, y));
      }
    }
  }

  const switchCells = new Set<string>();
  const gateCells = new Set<string>();
  for (const gate of gates) {
    switchCells.add(keyOf(gate.switchA.x, gate.switchA.y));
    switchCells.add(keyOf(gate.switchB.x, gate.switchB.y));
    gateCells.add(keyOf(gate.a.x, gate.a.y));
    gateCells.add(keyOf(gate.b.x, gate.b.y));
  }

  const dots = new Set<string>();
  for (const sector of sectors) {
    let dotCount = 0;
    for (const cell of sector.floorCells) {
      const key = keyOf(cell.x, cell.y);
      if (pelletKeys.has(key) || spawnProtected.has(key) || switchCells.has(key) || gateCells.has(key)) {
        continue;
      }
      dots.add(key);
      dotCount += 1;
    }
    sector.dotCount = dotCount;
    sector.totalDots = dotCount;
    sector.respawnCandidates = sector.floorCells.filter((cell) => {
      const key = keyOf(cell.x, cell.y);
      return !pelletKeys.has(key) && !spawnProtected.has(key) && !switchCells.has(key) && !gateCells.has(key);
    });
  }

  return {
    width,
    height,
    side,
    sectorSize: SECTOR_SIZE,
    tiles: grid.map((row) => row.join('')),
    sectors,
    gates,
    dots,
    powerPellets,
    playerSpawnCells,
    ghostSpawnCells,
  };
}

export function toWorldInit(world: GeneratedWorld): WorldInit {
  return {
    width: world.width,
    height: world.height,
    sectorSize: world.sectorSize,
    side: world.side,
    tiles: world.tiles,
    sectors: world.sectors.map((sector) => ({
      id: sector.id,
      row: sector.row,
      col: sector.col,
      x: sector.x,
      y: sector.y,
      size: sector.size,
      type: sector.type,
      discovered: sector.discovered,
      captured: sector.captured,
      dotCount: sector.dotCount,
      totalDots: sector.totalDots,
    })),
    gates: world.gates,
    dots: Array.from(world.dots.values()).map((key) => {
      const [x, y] = key.split(',').map(Number);
      return [x, y] as [number, number];
    }),
    powerPellets: Array.from(world.powerPellets.values()).map((pellet) => ({
      key: pellet.key,
      x: pellet.x,
      y: pellet.y,
      active: pellet.active,
    })),
  };
}

function pickSectorType(row: number, col: number, side: number, rng: Rng): SectorType {
  const center = (side - 1) / 2;
  const dist = Math.abs(row - center) + Math.abs(col - center);
  const maxDist = center * 2 + 1;
  const centerBias = 1 - Math.min(1, dist / maxDist);

  const weights: Record<SectorType, number> = {
    normal: 0.38 - centerBias * 0.12,
    narrow: 0.16 + centerBias * 0.03,
    plaza: 0.18 - centerBias * 0.02,
    dark: 0.08 + centerBias * 0.04,
    fast: 0.1 + centerBias * 0.03,
    nest: 0.1 + centerBias * 0.04,
  };

  let roll = rng.next();
  for (const type of SECTOR_TYPES) {
    roll -= weights[type];
    if (roll <= 0) {
      return type;
    }
  }
  return 'normal';
}

function buildSectorMaze(size: number, type: SectorType, rng: Rng): string[][] {
  const local: string[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => '#'));
  const stack: Vec2[] = [{ x: 1, y: 1 }];
  local[1][1] = '.';

  while (stack.length > 0) {
    const current = stack[stack.length - 1] as Vec2;
    const neighbors: Vec2[] = [];

    const candidates = [
      { x: current.x + 2, y: current.y },
      { x: current.x - 2, y: current.y },
      { x: current.x, y: current.y + 2 },
      { x: current.x, y: current.y - 2 },
    ];

    for (const next of candidates) {
      if (next.x <= 0 || next.y <= 0 || next.x >= size - 1 || next.y >= size - 1) {
        continue;
      }
      if (local[next.y][next.x] === '#') {
        neighbors.push(next);
      }
    }

    if (neighbors.length === 0) {
      stack.pop();
      continue;
    }

    const next = rng.pick(neighbors);
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    local[midY][midX] = '.';
    local[next.y][next.x] = '.';
    stack.push(next);
  }

  let extraOpenChance = 0.18;
  if (type === 'narrow') {
    extraOpenChance = 0.05;
  } else if (type === 'plaza') {
    extraOpenChance = 0.34;
  }

  for (let y = 2; y < size - 2; y += 1) {
    for (let x = 2; x < size - 2; x += 1) {
      if (local[y][x] === '#' && rng.bool(extraOpenChance)) {
        local[y][x] = '.';
      }
    }
  }

  if (type === 'plaza') {
    const mid = Math.floor(size / 2);
    for (let y = mid - 2; y <= mid + 2; y += 1) {
      for (let x = mid - 2; x <= mid + 2; x += 1) {
        local[y][x] = '.';
      }
    }
  }

  if (type === 'nest') {
    const mid = Math.floor(size / 2);
    for (let y = mid - 2; y <= mid + 2; y += 1) {
      for (let x = mid - 2; x <= mid + 2; x += 1) {
        local[y][x] = '.';
      }
    }
  }

  carveCorner(local, 2, 2);
  carveCorner(local, size - 3, 2);
  carveCorner(local, 2, size - 3);
  carveCorner(local, size - 3, size - 3);

  for (let i = 0; i < size; i += 1) {
    local[0][i] = '#';
    local[size - 1][i] = '#';
    local[i][0] = '#';
    local[i][size - 1] = '#';
  }

  return local;
}

function carveCorner(local: string[][], x: number, y: number): void {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const xx = x + dx;
      const yy = y + dy;
      if (yy <= 0 || xx <= 0 || yy >= local.length - 1 || xx >= local.length - 1) {
        continue;
      }
      local[yy][xx] = '.';
    }
  }
}

function connectRight(grid: string[][], row: number, col: number, side: number, rng: Rng): Connection | null {
  if (col >= side - 1) {
    return null;
  }

  const y0 = row * SECTOR_SIZE;
  const doorLocalY = ensureOdd(Math.floor(SECTOR_SIZE / 2) + rng.int(-3, 3));

  const xA = (col + 1) * SECTOR_SIZE - 1;
  const xB = xA + 1;
  const y = y0 + doorLocalY;

  setFloor(grid, xA - 1, y);
  setFloor(grid, xA, y);
  setFloor(grid, xB, y);
  setFloor(grid, xB + 1, y);

  return {
    a: { x: xA, y },
    b: { x: xB, y },
    switchA: { x: xA - 2, y },
    switchB: { x: xB + 2, y },
  };
}

function connectDown(grid: string[][], row: number, col: number, side: number, rng: Rng): Connection | null {
  if (row >= side - 1) {
    return null;
  }

  const x0 = col * SECTOR_SIZE;
  const doorLocalX = ensureOdd(Math.floor(SECTOR_SIZE / 2) + rng.int(-3, 3));

  const yA = (row + 1) * SECTOR_SIZE - 1;
  const yB = yA + 1;
  const x = x0 + doorLocalX;

  setFloor(grid, x, yA - 1);
  setFloor(grid, x, yA);
  setFloor(grid, x, yB);
  setFloor(grid, x, yB + 1);

  return {
    a: { x, y: yA },
    b: { x, y: yB },
    switchA: { x, y: yA - 2 },
    switchB: { x, y: yB + 2 },
  };
}

function setFloor(grid: string[][], x: number, y: number): void {
  if (y <= 0 || x <= 0 || y >= grid.length - 1 || x >= grid[0].length - 1) {
    return;
  }
  grid[y][x] = '.';
}

function ensureOdd(value: number): number {
  if (value % 2 === 1) {
    return value;
  }
  return value + 1;
}

function scanSectorFloorCells(grid: string[][], sector: SectorInternal): void {
  const cells: Vec2[] = [];
  for (let y = sector.y; y < sector.y + sector.size; y += 1) {
    for (let x = sector.x; x < sector.x + sector.size; x += 1) {
      if (grid[y][x] === '.') {
        cells.push({ x, y });
      }
    }
  }
  sector.floorCells = cells;
}

function placeSectorPowerPellets(grid: string[][], sector: SectorInternal, rng: Rng): Vec2[] {
  const offsets: Vec2[] = [
    { x: 2, y: 2 },
    { x: sector.size - 3, y: 2 },
    { x: 2, y: sector.size - 3 },
    { x: sector.size - 3, y: sector.size - 3 },
  ];

  const results: Vec2[] = [];
  for (const offset of offsets) {
    const targetX = sector.x + offset.x;
    const targetY = sector.y + offset.y;
    const nearest = findNearestFloor(grid, sector, targetX, targetY, rng);
    if (nearest) {
      results.push(nearest);
    }
  }

  return dedupeVec(results);
}

function findNearestFloor(
  grid: string[][],
  sector: SectorInternal,
  targetX: number,
  targetY: number,
  rng: Rng,
): Vec2 | null {
  let best: Vec2 | null = null;
  let bestDist = Number.POSITIVE_INFINITY;

  for (let y = sector.y; y < sector.y + sector.size; y += 1) {
    for (let x = sector.x; x < sector.x + sector.size; x += 1) {
      if (grid[y][x] !== '.') {
        continue;
      }
      const dist = manhattan(x, y, targetX, targetY) + rng.next() * 0.05;
      if (dist < bestDist) {
        best = { x, y };
        bestDist = dist;
      }
    }
  }

  return best;
}

function dedupeVec(values: Vec2[]): Vec2[] {
  const seen = new Set<string>();
  const out: Vec2[] = [];
  for (const value of values) {
    const key = keyOf(value.x, value.y);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(value);
  }
  return out;
}

function collectPlayerSpawns(sectors: SectorInternal[], grid: string[][], side: number): Vec2[] {
  const values: Vec2[] = [];

  for (const sector of sectors) {
    const onEdge =
      sector.row === 0 ||
      sector.col === 0 ||
      sector.row === side - 1 ||
      sector.col === side - 1;
    if (!onEdge) {
      continue;
    }
    const spawn = findNearestFloor(
      grid,
      sector,
      sector.x + Math.floor(sector.size / 2),
      sector.y + Math.floor(sector.size / 2),
      new Rng((sector.id + 1) * 12345),
    );
    if (spawn) {
      values.push(spawn);
    }
  }

  if (values.length === 0) {
    values.push({ x: 1, y: 1 });
  }

  return values;
}

function collectGhostSpawns(sectors: SectorInternal[], grid: string[][], side: number): Vec2[] {
  const nestSpawns: Vec2[] = [];
  for (const sector of sectors) {
    if (sector.type !== 'nest') {
      continue;
    }
    const center = findNearestFloor(
      grid,
      sector,
      sector.x + Math.floor(sector.size / 2),
      sector.y + Math.floor(sector.size / 2),
      new Rng((sector.id + 1) * 9987),
    );
    if (center) {
      nestSpawns.push(center);
    }
  }

  if (nestSpawns.length > 0) {
    return nestSpawns;
  }

  const centerSector = sectors[Math.floor((side * side) / 2)] ?? sectors[0];
  const fallback = findNearestFloor(
    grid,
    centerSector,
    centerSector.x + Math.floor(centerSector.size / 2),
    centerSector.y + Math.floor(centerSector.size / 2),
    new Rng(42),
  );

  return fallback ? [fallback] : [{ x: Math.floor(SECTOR_SIZE / 2), y: Math.floor(SECTOR_SIZE / 2) }];
}
