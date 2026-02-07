use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};

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
    pub dots: BTreeSet<(i32, i32)>,
    pub power_pellets: BTreeMap<String, PowerPelletInternal>,
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
            if col < side - 1 {
                if rng.bool(gate_chance) {
                    let conn = connect_right(&mut grid, row, col, side);
                    gates.push(conn);
                } else {
                    open_right_passage(&mut grid, row, col, side);
                }
            }
            if row < side - 1 {
                if rng.bool(gate_chance) {
                    let conn = connect_down(&mut grid, row, col, side);
                    gates.push(conn);
                } else {
                    open_down_passage(&mut grid, row, col, side);
                }
            }
        }
    }

    let mut power_pellets = BTreeMap::new();
    for sector in &mut sectors {
        scan_sector_floor_cells(&grid, sector);
        let pellets = place_sector_power_pellets(sector, &mut rng);
        for pos in pellets {
            let key = key_of(pos.x, pos.y);
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
    let ghost_spawn_cells = collect_ghost_spawns(&sectors, side, &player_spawn_cells);
    let primary_spawn = player_spawn_cells
        .first()
        .copied()
        .or_else(|| sectors.iter().find_map(|sector| sector.floor_cells.first().copied()));
    let reachable_floor_cells = build_reachable_floor_cells(&grid, width, height, primary_spawn);

    power_pellets.retain(|_, pellet| reachable_floor_cells.contains(&(pellet.x, pellet.y)));
    let pellet_keys: HashSet<(i32, i32)> = power_pellets.values().map(|pellet| (pellet.x, pellet.y)).collect();

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
    let mut dots = BTreeSet::new();
    for sector in &mut sectors {
        let mut dot_count = 0;
        for cell in &sector.floor_cells {
            if !reachable_floor_cells.contains(&(cell.x, cell.y))
                || pellet_keys.contains(&(cell.x, cell.y))
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
                reachable_floor_cells.contains(&(cell.x, cell.y))
                    && !pellet_keys.contains(&(cell.x, cell.y))
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
    let switch_a_x = x_left - 2;
    let switch_b_x = x_right + 2;
    grid[y_center as usize][(x_left - 1) as usize] = '.';
    grid[y_center as usize][x_left as usize] = '.';
    grid[y_center as usize][x_right as usize] = '.';
    grid[y_center as usize][(x_right + 1).min(side * SECTOR_SIZE - 1) as usize] = '.';
    if switch_a_x >= 0 && switch_a_x < side * SECTOR_SIZE {
        grid[y_center as usize][switch_a_x as usize] = '.';
    }
    if switch_b_x >= 0 && switch_b_x < side * SECTOR_SIZE {
        grid[y_center as usize][switch_b_x as usize] = '.';
    }

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
            x: switch_a_x,
            y: y_center,
        },
        switch_b: Vec2 {
            x: switch_b_x,
            y: y_center,
        },
        open: false,
        permanent: false,
    }
}

fn open_right_passage(grid: &mut [Vec<char>], row: i32, col: i32, side: i32) {
    let y_center = row * SECTOR_SIZE + SECTOR_SIZE / 2;
    let x_left = col * SECTOR_SIZE + SECTOR_SIZE - 1;
    let x_right = (col + 1) * SECTOR_SIZE;
    grid[y_center as usize][(x_left - 1) as usize] = '.';
    grid[y_center as usize][x_left as usize] = '.';
    grid[y_center as usize][x_right as usize] = '.';
    grid[y_center as usize][(x_right + 1).min(side * SECTOR_SIZE - 1) as usize] = '.';
}

fn connect_down(grid: &mut [Vec<char>], row: i32, col: i32, side: i32) -> GateState {
    let x_center = col * SECTOR_SIZE + SECTOR_SIZE / 2;
    let y_top = row * SECTOR_SIZE + SECTOR_SIZE - 1;
    let y_bottom = (row + 1) * SECTOR_SIZE;
    let switch_a_y = y_top - 2;
    let switch_b_y = y_bottom + 2;
    grid[(y_top - 1) as usize][x_center as usize] = '.';
    grid[y_top as usize][x_center as usize] = '.';
    grid[y_bottom as usize][x_center as usize] = '.';
    grid[(y_bottom + 1).min(side * SECTOR_SIZE - 1) as usize][x_center as usize] = '.';
    if switch_a_y >= 0 && switch_a_y < side * SECTOR_SIZE {
        grid[switch_a_y as usize][x_center as usize] = '.';
    }
    if switch_b_y >= 0 && switch_b_y < side * SECTOR_SIZE {
        grid[switch_b_y as usize][x_center as usize] = '.';
    }

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
            y: switch_a_y,
        },
        switch_b: Vec2 {
            x: x_center,
            y: switch_b_y,
        },
        open: false,
        permanent: false,
    }
}

fn open_down_passage(grid: &mut [Vec<char>], row: i32, col: i32, side: i32) {
    let x_center = col * SECTOR_SIZE + SECTOR_SIZE / 2;
    let y_top = row * SECTOR_SIZE + SECTOR_SIZE - 1;
    let y_bottom = (row + 1) * SECTOR_SIZE;
    grid[(y_top - 1) as usize][x_center as usize] = '.';
    grid[y_top as usize][x_center as usize] = '.';
    grid[y_bottom as usize][x_center as usize] = '.';
    grid[(y_bottom + 1).min(side * SECTOR_SIZE - 1) as usize][x_center as usize] = '.';
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
    let avoid = HashSet::new();
    for sector in sectors {
        let on_edge = sector.view.row == 0
            || sector.view.col == 0
            || sector.view.row == side - 1
            || sector.view.col == side - 1;
        if !on_edge {
            continue;
        }
        if let Some(spawn) = find_nearest_floor(
            sector,
            sector.view.x + sector.view.size / 2,
            sector.view.y + sector.view.size / 2,
            &avoid,
        ) {
            out.push(spawn);
        }
    }

    if out.is_empty() {
        let fallback = sectors
            .iter()
            .find_map(|sector| sector.floor_cells.first().copied())
            .unwrap_or(Vec2 {
                x: SECTOR_SIZE / 2,
                y: SECTOR_SIZE / 2,
            });
        out.push(fallback);
    }
    dedupe_vec2(out)
}

fn collect_ghost_spawns(
    sectors: &[SectorInternal],
    side: i32,
    player_spawns: &[Vec2],
) -> Vec<Vec2> {
    let mut avoid = HashSet::new();
    for spawn in player_spawns {
        avoid.insert((spawn.x, spawn.y));
    }

    let mut nest_spawns = Vec::new();
    for sector in sectors {
        if sector.view.sector_type != SectorType::Nest {
            continue;
        }
        if let Some(spawn) = find_nearest_floor(
            sector,
            sector.view.x + sector.view.size / 2,
            sector.view.y + sector.view.size / 2,
            &avoid,
        ) {
            nest_spawns.push(spawn);
        }
    }
    if !nest_spawns.is_empty() {
        return dedupe_vec2(nest_spawns);
    }

    let center_id = ((side * side) / 2) as usize;
    let center_sector = sectors.get(center_id).or_else(|| sectors.first());
    if let Some(sector) = center_sector {
        if let Some(spawn) = find_nearest_floor(
            sector,
            sector.view.x + sector.view.size / 2,
            sector.view.y + sector.view.size / 2,
            &avoid,
        ) {
            return vec![spawn];
        }
    }

    for sector in sectors {
        if let Some(spawn) = find_nearest_floor(
            sector,
            sector.view.x + sector.view.size / 2,
            sector.view.y + sector.view.size / 2,
            &avoid,
        ) {
            return vec![spawn];
        }
    }

    let fallback = sectors
        .first()
        .and_then(|sector| sector.floor_cells.first().cloned())
        .unwrap_or(Vec2 {
            x: SECTOR_SIZE / 2,
            y: SECTOR_SIZE / 2,
        });
    vec![fallback]
}

fn find_nearest_floor(
    sector: &SectorInternal,
    target_x: i32,
    target_y: i32,
    avoid: &HashSet<(i32, i32)>,
) -> Option<Vec2> {
    let mut best: Option<(i32, i32, i32, Vec2)> = None;
    for cell in &sector.floor_cells {
        if avoid.contains(&(cell.x, cell.y)) {
            continue;
        }
        let dist = (cell.x - target_x).abs() + (cell.y - target_y).abs();
        let key = (dist, cell.y, cell.x, *cell);
        if best
            .map(|v| (v.0, v.1, v.2) > (key.0, key.1, key.2))
            .unwrap_or(true)
        {
            best = Some(key);
        }
    }
    best.map(|(_, _, _, cell)| cell)
}

fn dedupe_vec2(values: Vec<Vec2>) -> Vec<Vec2> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for value in values {
        if seen.insert((value.x, value.y)) {
            out.push(value);
        }
    }
    out
}

fn build_reachable_floor_cells(
    grid: &[Vec<char>],
    width: i32,
    height: i32,
    start: Option<Vec2>,
) -> HashSet<(i32, i32)> {
    let mut out = HashSet::new();
    let Some(start) = start else {
        return out;
    };
    if start.x < 0 || start.y < 0 || start.x >= width || start.y >= height {
        return out;
    }
    if grid[start.y as usize][start.x as usize] != '.' {
        return out;
    }

    let mut queue = VecDeque::new();
    out.insert((start.x, start.y));
    queue.push_back((start.x, start.y));

    while let Some((x, y)) = queue.pop_front() {
        for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] {
            if nx < 0 || ny < 0 || nx >= width || ny >= height {
                continue;
            }
            if grid[ny as usize][nx as usize] != '.' {
                continue;
            }
            if out.insert((nx, ny)) {
                queue.push_back((nx, ny));
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use std::collections::{HashSet, VecDeque};

    use crate::constants::SECTOR_SIZE;

    use super::{generate_world, is_walkable};

    fn reachable_from_primary_spawn(
        world: &super::GeneratedWorld,
    ) -> HashSet<(i32, i32)> {
        let mut out = HashSet::new();
        let Some(start) = world.player_spawn_cells.first().copied() else {
            return out;
        };
        if !is_walkable(world, start.x, start.y) {
            return out;
        }

        let mut queue = VecDeque::new();
        out.insert((start.x, start.y));
        queue.push_back((start.x, start.y));

        while let Some((x, y)) = queue.pop_front() {
            for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] {
                if !is_walkable(world, nx, ny) {
                    continue;
                }
                if out.insert((nx, ny)) {
                    queue.push_back((nx, ny));
                }
            }
        }

        out
    }

    #[test]
    fn gate_cells_are_walkable_when_generated() {
        let mut found_gate = false;
        for seed in 0..200u32 {
            let world = generate_world(20, seed);
            if world.gates.is_empty() {
                continue;
            }
            found_gate = true;
            for gate in &world.gates {
                assert!(is_walkable(&world, gate.a.x, gate.a.y));
                assert!(is_walkable(&world, gate.b.x, gate.b.y));
                assert!(is_walkable(&world, gate.switch_a.x, gate.switch_a.y));
                assert!(is_walkable(&world, gate.switch_b.x, gate.switch_b.y));
            }
        }
        assert!(found_gate);
    }

    #[test]
    fn adjacent_sectors_are_connected_even_without_gate() {
        for seed in 0..100u32 {
            let world = generate_world(20, seed);
            for row in 0..world.side {
                for col in 0..world.side {
                    if col < world.side - 1 {
                        let x_left = col * SECTOR_SIZE + SECTOR_SIZE - 1;
                        let x_right = (col + 1) * SECTOR_SIZE;
                        let y0 = row * SECTOR_SIZE;
                        let mut connected = false;
                        for y in y0..(y0 + SECTOR_SIZE) {
                            if is_walkable(&world, x_left, y) && is_walkable(&world, x_right, y) {
                                connected = true;
                                break;
                            }
                        }
                        assert!(connected);
                    }

                    if row < world.side - 1 {
                        let y_top = row * SECTOR_SIZE + SECTOR_SIZE - 1;
                        let y_bottom = (row + 1) * SECTOR_SIZE;
                        let x0 = col * SECTOR_SIZE;
                        let mut connected = false;
                        for x in x0..(x0 + SECTOR_SIZE) {
                            if is_walkable(&world, x, y_top) && is_walkable(&world, x, y_bottom) {
                                connected = true;
                                break;
                            }
                        }
                        assert!(connected);
                    }
                }
            }
        }
    }

    #[test]
    fn player_and_ghost_spawns_do_not_overlap() {
        for seed in 0..200u32 {
            let world = generate_world(10, seed);
            assert!(!world.player_spawn_cells.is_empty());
            assert!(!world.ghost_spawn_cells.is_empty());

            for spawn in &world.player_spawn_cells {
                let row = spawn.y / world.sector_size;
                let col = spawn.x / world.sector_size;
                let on_edge =
                    row == 0 || col == 0 || row == world.side - 1 || col == world.side - 1;
                assert!(on_edge);
            }

            for ghost_spawn in &world.ghost_spawn_cells {
                let overlap = world
                    .player_spawn_cells
                    .iter()
                    .any(|player_spawn| player_spawn == ghost_spawn);
                assert!(!overlap);
            }
        }
    }

    #[test]
    fn dots_and_pellets_are_reachable_from_primary_spawn() {
        for seed in 0..200u32 {
            let world = generate_world(10, seed);
            let reachable = reachable_from_primary_spawn(&world);

            for &(x, y) in &world.dots {
                assert!(
                    reachable.contains(&(x, y)),
                    "dot is unreachable: seed={seed}, pos=({x},{y})"
                );
            }

            for pellet in world.power_pellets.values() {
                assert!(
                    reachable.contains(&(pellet.x, pellet.y)),
                    "pellet is unreachable: seed={seed}, pos=({},{})",
                    pellet.x,
                    pellet.y
                );
            }
        }
    }
}
