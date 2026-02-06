use std::collections::{HashMap, HashSet};

use crate::constants::{get_map_side_by_player_count, SECTOR_SIZE};
use crate::rng::Rng;
use crate::types::{GateState, SectorState, SectorType, Vec2, WorldInit};

#[derive(Clone, Debug)]
pub struct PowerPelletInternal {
    pub key: String,
    pub x: i32,
    pub y: i32,
    pub active: bool,
    pub respawn_at: u64,
}

#[derive(Clone, Debug)]
pub struct SectorInternal {
    pub view: SectorState,
    pub floor_cells: Vec<Vec2>,
    pub respawn_candidates: Vec<Vec2>,
    pub captured_at: u64,
    pub regen_accumulator: f32,
}

#[derive(Clone, Debug)]
pub struct GeneratedWorld {
    pub width: i32,
    pub height: i32,
    pub side: i32,
    pub sector_size: i32,
    pub tiles: Vec<String>,
    pub sectors: Vec<SectorInternal>,
    pub gates: Vec<GateState>,
    pub dots: HashSet<(i32, i32)>,
    pub power_pellets: HashMap<String, PowerPelletInternal>,
    pub player_spawn_cells: Vec<Vec2>,
    pub ghost_spawn_cells: Vec<Vec2>,
}

pub fn generate_world(player_count: usize, seed: u32) -> GeneratedWorld {
    let mut rng = Rng::new(seed);
    let side = get_map_side_by_player_count(player_count.max(2));
    let width = side * SECTOR_SIZE;
    let height = side * SECTOR_SIZE;
    let mut grid: Vec<Vec<char>> = vec![vec!['#'; width as usize]; height as usize];
    let mut sectors = Vec::new();

    for row in 0..side {
        for col in 0..side {
            let id = (row * side + col) as usize;
            let sector_type = pick_sector_type(&mut rng);
            let x0 = col * SECTOR_SIZE;
            let y0 = row * SECTOR_SIZE;
            carve_sector(&mut grid, x0, y0, SECTOR_SIZE, sector_type, &mut rng);
            sectors.push(SectorInternal {
                view: SectorState {
                    id,
                    row,
                    col,
                    x: x0,
                    y: y0,
                    size: SECTOR_SIZE,
                    sector_type,
                    discovered: false,
                    captured: false,
                    dot_count: 0,
                    total_dots: 0,
                },
                floor_cells: Vec::new(),
                respawn_candidates: Vec::new(),
                captured_at: 0,
                regen_accumulator: 0.0,
            });
        }
    }

    let gate_chance = ((player_count as f32) / 320.0).clamp(0.08, 0.32);
    let mut gates = Vec::new();
    for row in 0..side {
        for col in 0..side {
            if col < side - 1 && rng.bool(gate_chance) {
                let conn = connect_right(&mut grid, row, col, side);
                gates.push(conn);
            }
            if row < side - 1 && rng.bool(gate_chance) {
                let conn = connect_down(&mut grid, row, col, side);
                gates.push(conn);
            }
        }
    }

    let mut pellet_keys = HashSet::new();
    let mut power_pellets = HashMap::new();
    for sector in &mut sectors {
        scan_sector_floor_cells(&grid, sector);
        let pellets = place_sector_power_pellets(sector, &mut rng);
        for pos in pellets {
            let key = key_of(pos.x, pos.y);
            pellet_keys.insert((pos.x, pos.y));
            power_pellets.insert(
                key.clone(),
                PowerPelletInternal {
                    key,
                    x: pos.x,
                    y: pos.y,
                    active: true,
                    respawn_at: 0,
                },
            );
        }
    }

    let player_spawn_cells = collect_player_spawns(&sectors, side);
    let ghost_spawn_cells = collect_ghost_spawns(&sectors, side);

    let mut spawn_protected = HashSet::new();
    for spawn in &player_spawn_cells {
        for dy in -2..=2 {
            for dx in -2..=2 {
                let x = spawn.x + dx;
                let y = spawn.y + dy;
                if x < 0 || y < 0 || x >= width || y >= height {
                    continue;
                }
                spawn_protected.insert((x, y));
            }
        }
    }

    let gate_switch_cells = build_gate_switch_cell_set(&gates);
    let mut dots = HashSet::new();
    for sector in &mut sectors {
        let mut dot_count = 0;
        for cell in &sector.floor_cells {
            if pellet_keys.contains(&(cell.x, cell.y))
                || spawn_protected.contains(&(cell.x, cell.y))
                || gate_switch_cells.contains(&(cell.x, cell.y))
            {
                continue;
            }
            dots.insert((cell.x, cell.y));
            dot_count += 1;
        }
        sector.view.dot_count = dot_count;
        sector.view.total_dots = dot_count;
        sector.respawn_candidates = sector
            .floor_cells
            .iter()
            .filter(|cell| {
                !pellet_keys.contains(&(cell.x, cell.y))
                    && !spawn_protected.contains(&(cell.x, cell.y))
                    && !gate_switch_cells.contains(&(cell.x, cell.y))
            })
            .cloned()
            .collect();
    }

    GeneratedWorld {
        width,
        height,
        side,
        sector_size: SECTOR_SIZE,
        tiles: grid
            .into_iter()
            .map(|row| row.into_iter().collect::<String>())
            .collect(),
        sectors,
        gates,
        dots,
        power_pellets,
        player_spawn_cells,
        ghost_spawn_cells,
    }
}

pub fn to_world_init(world: &GeneratedWorld) -> WorldInit {
    WorldInit {
        width: world.width,
        height: world.height,
        sector_size: world.sector_size,
        side: world.side,
        tiles: world.tiles.clone(),
        sectors: world.sectors.iter().map(|s| s.view.clone()).collect(),
        gates: world.gates.clone(),
        dots: world.dots.iter().cloned().collect(),
        power_pellets: world
            .power_pellets
            .values()
            .map(|p| crate::types::PowerPelletView {
                key: p.key.clone(),
                x: p.x,
                y: p.y,
                active: p.active,
            })
            .collect(),
    }
}

pub fn is_walkable(world: &GeneratedWorld, x: i32, y: i32) -> bool {
    if x < 0 || y < 0 || x >= world.width || y >= world.height {
        return false;
    }
    world
        .tiles
        .get(y as usize)
        .and_then(|row| row.as_bytes().get(x as usize))
        .map(|c| *c == b'.')
        .unwrap_or(false)
}

pub fn key_of(x: i32, y: i32) -> String {
    format!("{x},{y}")
}

pub fn build_gate_switch_cell_set(gates: &[GateState]) -> HashSet<(i32, i32)> {
    let mut out = HashSet::new();
    for gate in gates {
        out.insert((gate.a.x, gate.a.y));
        out.insert((gate.b.x, gate.b.y));
        out.insert((gate.switch_a.x, gate.switch_a.y));
        out.insert((gate.switch_b.x, gate.switch_b.y));
    }
    out
}

pub fn is_gate_cell_or_switch(gates: &[GateState], x: i32, y: i32) -> bool {
    gates.iter().any(|gate| {
        (gate.a.x == x && gate.a.y == y)
            || (gate.b.x == x && gate.b.y == y)
            || (gate.switch_a.x == x && gate.switch_a.y == y)
            || (gate.switch_b.x == x && gate.switch_b.y == y)
    })
}

fn pick_sector_type(rng: &mut Rng) -> SectorType {
    let roll = rng.next_f32();
    if roll < 0.36 {
        return SectorType::Normal;
    }
    if roll < 0.5 {
        return SectorType::Narrow;
    }
    if roll < 0.65 {
        return SectorType::Plaza;
    }
    if roll < 0.75 {
        return SectorType::Dark;
    }
    if roll < 0.87 {
        return SectorType::Fast;
    }
    SectorType::Nest
}

fn carve_sector(
    grid: &mut [Vec<char>],
    x0: i32,
    y0: i32,
    size: i32,
    sector_type: SectorType,
    rng: &mut Rng,
) {
    let open_rate = match sector_type {
        SectorType::Normal => 0.82,
        SectorType::Narrow => 0.65,
        SectorType::Plaza => 0.94,
        SectorType::Dark => 0.78,
        SectorType::Fast => 0.86,
        SectorType::Nest => 0.8,
    };

    for ly in 0..size {
        for lx in 0..size {
            let x = x0 + lx;
            let y = y0 + ly;
            if lx == 0 || ly == 0 || lx == size - 1 || ly == size - 1 {
                grid[y as usize][x as usize] = '#';
                continue;
            }
            grid[y as usize][x as usize] = if rng.bool(open_rate) { '.' } else { '#' };
        }
    }

    let cx = x0 + size / 2;
    let cy = y0 + size / 2;
    for y in (cy - 1)..=(cy + 1) {
        for x in (cx - 1)..=(cx + 1) {
            grid[y as usize][x as usize] = '.';
        }
    }
}

fn connect_right(grid: &mut [Vec<char>], row: i32, col: i32, side: i32) -> GateState {
    let y_center = row * SECTOR_SIZE + SECTOR_SIZE / 2;
    let x_left = col * SECTOR_SIZE + SECTOR_SIZE - 1;
    let x_right = (col + 1) * SECTOR_SIZE;
    grid[y_center as usize][(x_left - 1) as usize] = '.';
    grid[y_center as usize][(x_right + 1).min(side * SECTOR_SIZE - 1) as usize] = '.';

    GateState {
        id: format!("gate_{}_{}", row, col),
        a: Vec2 {
            x: x_left,
            y: y_center,
        },
        b: Vec2 {
            x: x_right,
            y: y_center,
        },
        switch_a: Vec2 {
            x: x_left - 2,
            y: y_center,
        },
        switch_b: Vec2 {
            x: x_right + 2,
            y: y_center,
        },
        open: false,
        permanent: false,
    }
}

fn connect_down(grid: &mut [Vec<char>], row: i32, col: i32, side: i32) -> GateState {
    let x_center = col * SECTOR_SIZE + SECTOR_SIZE / 2;
    let y_top = row * SECTOR_SIZE + SECTOR_SIZE - 1;
    let y_bottom = (row + 1) * SECTOR_SIZE;
    grid[(y_top - 1) as usize][x_center as usize] = '.';
    grid[(y_bottom + 1).min(side * SECTOR_SIZE - 1) as usize][x_center as usize] = '.';

    GateState {
        id: format!("gate_{}_{}_down", row, col),
        a: Vec2 {
            x: x_center,
            y: y_top,
        },
        b: Vec2 {
            x: x_center,
            y: y_bottom,
        },
        switch_a: Vec2 {
            x: x_center,
            y: y_top - 2,
        },
        switch_b: Vec2 {
            x: x_center,
            y: y_bottom + 2,
        },
        open: false,
        permanent: false,
    }
}

fn scan_sector_floor_cells(grid: &[Vec<char>], sector: &mut SectorInternal) {
    sector.floor_cells.clear();
    for y in sector.view.y..(sector.view.y + sector.view.size) {
        for x in sector.view.x..(sector.view.x + sector.view.size) {
            if grid[y as usize][x as usize] == '.' {
                sector.floor_cells.push(Vec2 { x, y });
            }
        }
    }
}

fn place_sector_power_pellets(sector: &SectorInternal, rng: &mut Rng) -> Vec<Vec2> {
    if sector.floor_cells.is_empty() {
        return Vec::new();
    }
    let mut cells = sector.floor_cells.clone();
    let mut out = Vec::new();
    for _ in 0..2 {
        if cells.is_empty() {
            break;
        }
        let idx = rng.pick_index(cells.len());
        out.push(cells.swap_remove(idx));
    }
    out
}

fn collect_player_spawns(sectors: &[SectorInternal], side: i32) -> Vec<Vec2> {
    let mut out = Vec::new();
    for row in 0..side {
        for col in 0..side {
            let id = (row * side + col) as usize;
            if let Some(sector) = sectors.get(id) {
                out.push(Vec2 {
                    x: sector.view.x + sector.view.size / 2,
                    y: sector.view.y + sector.view.size / 2,
                });
            }
        }
    }
    out
}

fn collect_ghost_spawns(sectors: &[SectorInternal], side: i32) -> Vec<Vec2> {
    let center = side / 2;
    let mut out = Vec::new();
    for dr in -1..=1 {
        for dc in -1..=1 {
            let row = (center + dr).clamp(0, side - 1);
            let col = (center + dc).clamp(0, side - 1);
            let id = (row * side + col) as usize;
            if let Some(sector) = sectors.get(id) {
                out.push(Vec2 {
                    x: sector.view.x + sector.view.size / 2,
                    y: sector.view.y + sector.view.size / 2,
                });
            }
        }
    }
    out
}
