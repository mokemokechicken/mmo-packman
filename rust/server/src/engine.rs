use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::constants::{
    get_capture_pressure, get_difficulty_multiplier, get_initial_ghost_count, get_time_limit_ms,
    AWAKEN_DURATION_MS, DOTS_FOR_AWAKEN, GHOST_BASE_SPEED, MAX_AWAKEN_STOCK, PLAYER_BASE_SPEED,
    PLAYER_CAPTURED_SPEED_MULTIPLIER, POWER_DURATION_MS, POWER_PELLET_RESPAWN_MS,
    RESCUE_TIMEOUT_MS, TICK_RATE,
};
use crate::rng::Rng;
use crate::types::{
    Difficulty, Direction, FruitView, GameConfig, GameOverReason, GameSummary, GhostType,
    GhostView, PlayerState, PlayerView, RuntimeEvent, ScoreEntry, Snapshot, StartPlayer,
    TimelineEvent, Vec2,
};
use crate::world::{
    generate_world, is_gate_cell_or_switch, is_walkable, key_of, to_world_init, GeneratedWorld,
};

const AUTO_RESPAWN_GRACE_MS: u64 = 2_000;

#[derive(Clone, Debug, Default)]
struct PlayerStats {
    dots: i32,
    ghosts: i32,
    rescues: i32,
    captures: i32,
}

#[derive(Clone, Debug)]
struct PlayerInternal {
    view: PlayerView,
    desired_dir: Direction,
    move_buffer: f32,
    spawn: Vec2,
    reconnect_token: String,
    awaken_requested: bool,
    remote_revive_grace_until: u64,
    ai_think_at: u64,
    hold_until_ms: u64,
    stats: PlayerStats,
}

#[derive(Clone, Debug)]
struct GhostInternal {
    view: GhostView,
    move_buffer: f32,
}

#[derive(Clone, Debug)]
pub struct GameEngineOptions {
    pub time_limit_ms_override: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct GameEngine {
    pub started_at_ms: u64,
    pub config: GameConfig,
    pub world: GeneratedWorld,

    rng: Rng,
    players: Vec<PlayerInternal>,
    ghosts: Vec<GhostInternal>,
    fruits: Vec<FruitView>,
    events: Vec<RuntimeEvent>,
    timeline: Vec<TimelineEvent>,
    difficulty_multiplier: (f32, f32),
    max_ghosts: usize,
    player_count: usize,

    elapsed_ms: u64,
    ended: bool,
    end_reason: Option<GameOverReason>,
    tick_counter: u64,
    max_capture_ratio: f32,
    milestone_emitted: HashSet<i32>,
    next_id_counter: u64,
}

impl GameEngine {
    pub fn new(
        start_players: Vec<StartPlayer>,
        difficulty: Difficulty,
        seed: u32,
        options: GameEngineOptions,
    ) -> Self {
        let mut rng = Rng::new(seed);
        let player_count = start_players.len();
        let started_at_ms = now_ms();
        let world = generate_world(player_count, seed);
        let max_ghosts = get_initial_ghost_count(player_count);
        let difficulty_multiplier = get_difficulty_multiplier(difficulty);

        let config = GameConfig {
            tick_rate: TICK_RATE,
            dots_for_awaken: DOTS_FOR_AWAKEN,
            awaken_max_stock: MAX_AWAKEN_STOCK,
            power_duration_ms: POWER_DURATION_MS,
            awaken_duration_ms: AWAKEN_DURATION_MS,
            rescue_timeout_ms: RESCUE_TIMEOUT_MS,
            time_limit_ms: options
                .time_limit_ms_override
                .unwrap_or_else(|| get_time_limit_ms(player_count)),
            difficulty,
        };

        let mut players = Vec::new();
        let mut spawns = world.player_spawn_cells.clone();
        if spawns.is_empty() {
            spawns.push(Vec2 { x: 1, y: 1 });
        }

        for (index, start) in start_players.iter().enumerate() {
            let spawn = spawns[index % spawns.len()];
            players.push(PlayerInternal {
                view: PlayerView {
                    id: start.id.clone(),
                    name: start.name.clone(),
                    x: spawn.x,
                    y: spawn.y,
                    dir: Direction::None,
                    state: PlayerState::Normal,
                    stocks: 0,
                    gauge: 0,
                    gauge_max: DOTS_FOR_AWAKEN,
                    score: 0,
                    connected: start.connected,
                    ai: !start.connected,
                    speed_buff_until: 0,
                    power_until: 0,
                    down_since: None,
                },
                desired_dir: Direction::None,
                move_buffer: 0.0,
                spawn,
                reconnect_token: start.reconnect_token.clone(),
                awaken_requested: false,
                remote_revive_grace_until: 0,
                ai_think_at: rng.int(50, 180) as u64,
                hold_until_ms: 0,
                stats: PlayerStats::default(),
            });
        }

        let mut engine = Self {
            started_at_ms,
            config,
            world,
            rng,
            players,
            ghosts: Vec::new(),
            fruits: Vec::new(),
            events: Vec::new(),
            timeline: vec![TimelineEvent {
                at_ms: 0,
                label: "ゲーム開始".to_string(),
            }],
            difficulty_multiplier,
            max_ghosts,
            player_count,
            elapsed_ms: 0,
            ended: false,
            end_reason: None,
            tick_counter: 0,
            max_capture_ratio: 0.0,
            milestone_emitted: HashSet::new(),
            next_id_counter: 1,
        };
        engine.spawn_initial_ghosts();
        engine
    }

    pub fn is_ended(&self) -> bool {
        self.ended
    }

    pub fn get_world_init(&self) -> crate::types::WorldInit {
        to_world_init(&self.world)
    }

    pub fn get_reconnect_token(&self, player_id: &str) -> Option<String> {
        self.players
            .iter()
            .find(|player| player.view.id == player_id)
            .map(|player| player.reconnect_token.clone())
    }

    pub fn step(&mut self, dt_ms: u64) {
        if self.ended {
            return;
        }
        self.tick_counter += 1;
        self.elapsed_ms = self.elapsed_ms.saturating_add(dt_ms);
        let now_ms = self.started_at_ms.saturating_add(self.elapsed_ms);

        self.update_gates();
        self.update_power_pellets(now_ms);
        let player_positions_before_move: BTreeMap<String, (i32, i32)> = self
            .players
            .iter()
            .map(|player| (player.view.id.clone(), (player.view.x, player.view.y)))
            .collect();
        let ghost_positions_before_move: BTreeMap<String, (i32, i32)> = self
            .ghosts
            .iter()
            .map(|ghost| (ghost.view.id.clone(), (ghost.view.x, ghost.view.y)))
            .collect();
        self.update_players(dt_ms, now_ms);
        self.update_ghosts(dt_ms, now_ms);
        self.resolve_ghost_collisions(
            now_ms,
            &player_positions_before_move,
            &ghost_positions_before_move,
        );
        self.update_sector_control(dt_ms, now_ms);
        if self.tick_counter.is_multiple_of(TICK_RATE as u64) {
            self.adjust_ghost_population(now_ms);
            self.emit_progress_milestones();
        }
        self.check_game_over(now_ms);
    }

    pub fn build_snapshot(&mut self, include_events: bool) -> Snapshot {
        let time_left_ms = self
            .config
            .time_limit_ms
            .saturating_sub(self.elapsed_ms.min(self.config.time_limit_ms));
        let snapshot = Snapshot {
            tick: self.tick_counter,
            now_ms: self.started_at_ms + self.elapsed_ms,
            time_left_ms,
            capture_ratio: self.capture_ratio(),
            players: self.players.iter().map(|p| p.view.clone()).collect(),
            ghosts: self.ghosts.iter().map(|g| g.view.clone()).collect(),
            fruits: self.fruits.clone(),
            sectors: self.world.sectors.iter().map(|s| s.view.clone()).collect(),
            gates: self.world.gates.clone(),
            events: if include_events {
                self.events.clone()
            } else {
                Vec::new()
            },
            timeline: self
                .timeline
                .iter()
                .rev()
                .take(24)
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect(),
        };
        if include_events {
            self.events.clear();
        }
        snapshot
    }

    pub fn build_summary(&self) -> GameSummary {
        let mut ranking: Vec<ScoreEntry> = self
            .players
            .iter()
            .map(|player| ScoreEntry {
                player_id: player.view.id.clone(),
                name: player.view.name.clone(),
                score: player.view.score,
                dots: player.stats.dots,
                ghosts: player.stats.ghosts,
                rescues: player.stats.rescues,
                captures: player.stats.captures,
            })
            .collect();
        ranking.sort_by(|a, b| b.score.cmp(&a.score));

        GameSummary {
            reason: self.end_reason.unwrap_or(GameOverReason::Timeout),
            duration_ms: self.elapsed_ms,
            capture_ratio: self.capture_ratio(),
            timeline: self.timeline.clone(),
            ranking,
        }
    }

    fn update_gates(&mut self) {
        let standing_cells: HashSet<(i32, i32)> = self
            .players
            .iter()
            .filter(|p| p.view.state != PlayerState::Down)
            .map(|p| (p.view.x, p.view.y))
            .collect();
        for gate in &mut self.world.gates {
            if gate.permanent {
                gate.open = true;
                continue;
            }
            let a_pressed = standing_cells.contains(&(gate.switch_a.x, gate.switch_a.y));
            let b_pressed = standing_cells.contains(&(gate.switch_b.x, gate.switch_b.y));
            gate.open = a_pressed && b_pressed;
        }
    }

    fn update_power_pellets(&mut self, now_ms: u64) {
        let keys: Vec<String> = self.world.power_pellets.keys().cloned().collect();
        for key in keys {
            let Some(pellet_ro) = self.world.power_pellets.get(&key) else {
                continue;
            };
            if pellet_ro.active {
                continue;
            }
            let px = pellet_ro.x;
            let py = pellet_ro.y;
            let respawn_at = pellet_ro.respawn_at;
            if now_ms >= respawn_at {
                let blocked = !is_walkable(&self.world, px, py)
                    || is_gate_cell_or_switch(&self.world.gates, px, py);
                if blocked {
                    if let Some(pellet) = self.world.power_pellets.get_mut(&key) {
                        pellet.respawn_at = now_ms + 1_000;
                    }
                    continue;
                }
                if let Some(pellet) = self.world.power_pellets.get_mut(&key) {
                    pellet.active = true;
                }
                self.events.push(RuntimeEvent::PelletRespawned { key });
            }
        }
    }

    fn update_players(&mut self, dt_ms: u64, now_ms: u64) {
        let dt_sec = dt_ms as f32 / 1000.0;
        let capture_ratio = self.capture_ratio();

        for idx in 0..self.players.len() {
            if self.players[idx].view.state == PlayerState::Down {
                if let Some(down_since) = self.players[idx].view.down_since {
                    if now_ms.saturating_sub(down_since) >= RESCUE_TIMEOUT_MS {
                        self.auto_respawn(idx, now_ms);
                    }
                }
                continue;
            }

            if self.players[idx].view.state == PlayerState::Power
                && now_ms >= self.players[idx].view.power_until
            {
                self.players[idx].view.state = PlayerState::Normal;
            }

            if self.players[idx].view.ai {
                self.update_player_ai(idx, now_ms);
            }

            if self.players[idx].awaken_requested
                && self.players[idx].view.stocks > 0
                && self.players[idx].view.state != PlayerState::Down
            {
                self.players[idx].awaken_requested = false;
                self.players[idx].view.stocks -= 1;
                self.players[idx].view.state = PlayerState::Power;
                self.players[idx].view.power_until = now_ms + AWAKEN_DURATION_MS;
                self.events.push(RuntimeEvent::Toast {
                    message: format!("{} が覚醒", self.players[idx].view.name),
                });
            }

            if now_ms < self.players[idx].hold_until_ms {
                continue;
            }

            let mut speed = PLAYER_BASE_SPEED;
            if capture_ratio >= 0.7 {
                speed *= PLAYER_CAPTURED_SPEED_MULTIPLIER;
            }
            if self.players[idx].view.state == PlayerState::Power {
                speed *= 1.08;
            }

            self.players[idx].move_buffer += speed * dt_sec;
            let mut safety = 0;
            while self.players[idx].move_buffer >= 1.0 {
                self.players[idx].move_buffer -= 1.0;
                safety += 1;
                if safety > 6 {
                    break;
                }
                self.advance_player_one_cell(idx);
                self.apply_player_pickups(idx, now_ms);
            }
        }

        self.resolve_player_rescues(now_ms);
    }

    fn update_player_ai(&mut self, player_idx: usize, now_ms: u64) {
        if now_ms < self.players[player_idx].ai_think_at {
            return;
        }

        self.players[player_idx].ai_think_at = now_ms + self.rng.int(120, 260) as u64;
        let player = self.players[player_idx].view.clone();
        let nearest_ghost = self.distance_to_nearest_ghost(player.x, player.y);

        if let Some(dist) = nearest_ghost {
            if dist <= 2 {
                if player.stocks > 0 && player.state != PlayerState::Power {
                    self.players[player_idx].awaken_requested = true;
                }
                self.players[player_idx].desired_dir =
                    self.choose_escape_direction(player.x, player.y);
                return;
            }
        }

        if player.state == PlayerState::Power {
            self.players[player_idx].desired_dir = self.choose_chase_direction(player.x, player.y);
            return;
        }

        self.players[player_idx].desired_dir = self.choose_dot_direction(player.x, player.y);
    }

    fn update_ghosts(&mut self, dt_ms: u64, now_ms: u64) {
        let dt_sec = dt_ms as f32 / 1000.0;
        let ghost_speed = GHOST_BASE_SPEED * self.difficulty_multiplier.0;

        for idx in 0..self.ghosts.len() {
            if self.ghosts[idx].view.stunned_until > now_ms {
                continue;
            }
            self.ghosts[idx].move_buffer += ghost_speed * dt_sec;
            let mut safety = 0;
            while self.ghosts[idx].move_buffer >= 1.0 {
                self.ghosts[idx].move_buffer -= 1.0;
                safety += 1;
                if safety > 5 {
                    break;
                }

                let dir = self.choose_ghost_direction(idx);
                let _ = self.try_move_ghost(idx, dir);
            }
        }
    }

    fn choose_ghost_direction(&mut self, ghost_idx: usize) -> Direction {
        let ghost = self.ghosts[ghost_idx].view.clone();
        let players_alive: Vec<&PlayerInternal> = self
            .players
            .iter()
            .filter(|p| p.view.state != PlayerState::Down)
            .collect();
        if players_alive.is_empty() {
            return random_direction(&mut self.rng);
        }

        match ghost.ghost_type {
            GhostType::Random => random_direction(&mut self.rng),
            GhostType::Patrol => {
                if self.rng.bool(0.7) {
                    ghost.dir
                } else {
                    random_direction(&mut self.rng)
                }
            }
            GhostType::Pincer => {
                let mut sorted = players_alive;
                sorted.sort_by_key(|p| manhattan(ghost.x, ghost.y, p.view.x, p.view.y));
                let target = if sorted.len() >= 2 {
                    Vec2 {
                        x: (sorted[0].view.x + sorted[1].view.x) / 2,
                        y: (sorted[0].view.y + sorted[1].view.y) / 2,
                    }
                } else {
                    Vec2 {
                        x: sorted[0].view.x,
                        y: sorted[0].view.y,
                    }
                };
                self.choose_toward_direction(ghost.x, ghost.y, target.x, target.y)
            }
            GhostType::Invader => {
                let captured: Vec<_> = self
                    .world
                    .sectors
                    .iter()
                    .filter(|s| s.view.captured)
                    .collect();
                if !captured.is_empty() {
                    let idx = self.rng.pick_index(captured.len());
                    let sector = captured[idx];
                    return self.choose_toward_direction(
                        ghost.x,
                        ghost.y,
                        sector.view.x + sector.view.size / 2,
                        sector.view.y + sector.view.size / 2,
                    );
                }
                let nearest = self
                    .players
                    .iter()
                    .filter(|p| p.view.state != PlayerState::Down)
                    .min_by_key(|p| manhattan(ghost.x, ghost.y, p.view.x, p.view.y));
                if let Some(player) = nearest {
                    return self.choose_toward_direction(
                        ghost.x,
                        ghost.y,
                        player.view.x,
                        player.view.y,
                    );
                }
                random_direction(&mut self.rng)
            }
            GhostType::Boss | GhostType::Chaser => {
                let nearest = self
                    .players
                    .iter()
                    .filter(|p| p.view.state != PlayerState::Down)
                    .min_by_key(|p| manhattan(ghost.x, ghost.y, p.view.x, p.view.y));
                if let Some(player) = nearest {
                    return self.choose_toward_direction(
                        ghost.x,
                        ghost.y,
                        player.view.x,
                        player.view.y,
                    );
                }
                random_direction(&mut self.rng)
            }
        }
    }

    fn resolve_ghost_collisions(
        &mut self,
        now_ms: u64,
        player_positions_before_move: &BTreeMap<String, (i32, i32)>,
        ghost_positions_before_move: &BTreeMap<String, (i32, i32)>,
    ) {
        for player_idx in 0..self.players.len() {
            if self.players[player_idx].view.state == PlayerState::Down {
                continue;
            }
            for ghost_idx in 0..self.ghosts.len() {
                let overlap = self.players[player_idx].view.x == self.ghosts[ghost_idx].view.x
                    && self.players[player_idx].view.y == self.ghosts[ghost_idx].view.y;
                let swapped = match (
                    player_positions_before_move.get(&self.players[player_idx].view.id),
                    ghost_positions_before_move.get(&self.ghosts[ghost_idx].view.id),
                ) {
                    (
                        Some((player_before_x, player_before_y)),
                        Some((ghost_before_x, ghost_before_y)),
                    ) => {
                        *player_before_x == self.ghosts[ghost_idx].view.x
                            && *player_before_y == self.ghosts[ghost_idx].view.y
                            && *ghost_before_x == self.players[player_idx].view.x
                            && *ghost_before_y == self.players[player_idx].view.y
                    }
                    _ => false,
                };

                if !overlap && !swapped {
                    continue;
                }

                if self.players[player_idx].view.state == PlayerState::Power {
                    if self.ghosts[ghost_idx].view.ghost_type == GhostType::Boss {
                        self.ghosts[ghost_idx].view.hp -= 1;
                        self.events.push(RuntimeEvent::BossHit {
                            ghost_id: self.ghosts[ghost_idx].view.id.clone(),
                            hp: self.ghosts[ghost_idx].view.hp.max(0),
                            by: self.players[player_idx].view.id.clone(),
                        });
                        if self.ghosts[ghost_idx].view.hp <= 0 {
                            self.players[player_idx].view.score += 500;
                            self.players[player_idx].stats.ghosts += 1;
                            self.respawn_ghost(ghost_idx);
                        } else {
                            self.ghosts[ghost_idx].view.stunned_until = now_ms + 1_000;
                        }
                    } else {
                        self.players[player_idx].view.score += 120;
                        self.players[player_idx].stats.ghosts += 1;
                        self.respawn_ghost(ghost_idx);
                    }
                } else if now_ms >= self.players[player_idx].remote_revive_grace_until {
                    self.down_player(player_idx, now_ms);
                }
            }
        }
    }

    fn update_sector_control(&mut self, dt_ms: u64, now_ms: u64) {
        for sector_id in 0..self.world.sectors.len() {
            if !self.world.sectors[sector_id].view.captured
                && self.world.sectors[sector_id].view.dot_count <= 0
            {
                self.capture_sector(sector_id, now_ms);
            }
        }

        let capture_ratio = self.capture_ratio();
        self.max_capture_ratio = self.max_capture_ratio.max(capture_ratio);
        let (grace_ms, regen_multiplier) = get_capture_pressure(capture_ratio);
        let dt_sec = dt_ms as f32 / 1000.0;

        for sector_id in 0..self.world.sectors.len() {
            if !self.world.sectors[sector_id].view.captured {
                self.world.sectors[sector_id].regen_accumulator = 0.0;
                continue;
            }
            if now_ms.saturating_sub(self.world.sectors[sector_id].captured_at) < grace_ms {
                continue;
            }

            let invaders = self.count_ghost_by_sector_and_type(sector_id, GhostType::Invader);
            let invader_boost = if invaders > 0 {
                1.0 + invaders as f32 * 0.4
            } else {
                1.0
            };
            let regen_rate = 0.33 * regen_multiplier * self.difficulty_multiplier.1 * invader_boost;
            self.world.sectors[sector_id].regen_accumulator += regen_rate * dt_sec;

            while self.world.sectors[sector_id].regen_accumulator >= 1.0 {
                if !self.respawn_dot_in_sector(sector_id) {
                    self.world.sectors[sector_id].regen_accumulator = 0.0;
                    break;
                }
                self.world.sectors[sector_id].regen_accumulator -= 1.0;
            }

            let threshold =
                ((self.world.sectors[sector_id].view.total_dots as f32) * 0.05).floor() as i32;
            if self.world.sectors[sector_id].view.dot_count > threshold.max(1) {
                self.world.sectors[sector_id].view.captured = false;
                self.world.sectors[sector_id].regen_accumulator = 0.0;
                self.events.push(RuntimeEvent::SectorLost { sector_id });
            }
        }
    }

    fn adjust_ghost_population(&mut self, now_ms: u64) {
        let ratio = self.capture_ratio();
        let active_players = self
            .players
            .iter()
            .filter(|p| p.view.state != PlayerState::Down)
            .count();
        let target = ((self.max_ghosts as f32 * 0.5)
            .max(active_players as f32 * (1.0 + ratio * 0.7)))
        .round();
        let target = target.clamp(4.0, self.max_ghosts as f32) as usize;

        if self.ghosts.len() < target {
            let add = (target - self.ghosts.len()).min(3);
            for _ in 0..add {
                self.spawn_ghost(now_ms, ratio);
            }
        } else if self.ghosts.len() > target {
            let remove = (self.ghosts.len() - target).min(2);
            for _ in 0..remove {
                if !self.ghosts.is_empty() {
                    let idx = self.rng.pick_index(self.ghosts.len());
                    self.ghosts.swap_remove(idx);
                }
            }
        }
    }

    fn check_game_over(&mut self, now_ms: u64) {
        if self.elapsed_ms >= self.config.time_limit_ms {
            self.ended = true;
            self.end_reason = Some(GameOverReason::Timeout);
            self.timeline.push(TimelineEvent {
                at_ms: self.elapsed_ms,
                label: "タイムアップ".to_string(),
            });
            return;
        }

        let all_down = self
            .players
            .iter()
            .all(|p| p.view.state == PlayerState::Down);
        if all_down {
            self.ended = true;
            self.end_reason = Some(GameOverReason::AllDown);
            self.timeline.push(TimelineEvent {
                at_ms: self.elapsed_ms,
                label: "全員ダウン".to_string(),
            });
            return;
        }

        let capture_ratio = self.capture_ratio();
        if capture_ratio >= 0.995 {
            self.ended = true;
            self.end_reason = Some(GameOverReason::Victory);
            self.timeline.push(TimelineEvent {
                at_ms: self.elapsed_ms,
                label: "全エリア制覇".to_string(),
            });
            return;
        }

        if self.max_capture_ratio >= 0.7
            && capture_ratio <= 0.12
            && now_ms >= self.started_at_ms + 180_000
        {
            self.ended = true;
            self.end_reason = Some(GameOverReason::Collapse);
            self.timeline.push(TimelineEvent {
                at_ms: self.elapsed_ms,
                label: "制圧崩壊".to_string(),
            });
        }
    }

    fn emit_progress_milestones(&mut self) {
        let ratio = self.capture_ratio();
        for milestone in [20, 40, 60, 80, 90] {
            if ratio >= milestone as f32 / 100.0 && !self.milestone_emitted.contains(&milestone) {
                self.milestone_emitted.insert(milestone);
                self.timeline.push(TimelineEvent {
                    at_ms: self.elapsed_ms,
                    label: format!("制覇率{}%", milestone),
                });
            }
        }
    }

    fn capture_ratio(&self) -> f32 {
        if self.world.sectors.is_empty() {
            return 0.0;
        }
        let captured = self
            .world
            .sectors
            .iter()
            .filter(|s| s.view.captured)
            .count();
        captured as f32 / self.world.sectors.len() as f32
    }

    fn choose_dot_direction(&mut self, x: i32, y: i32) -> Direction {
        let dirs = [
            Direction::Up,
            Direction::Down,
            Direction::Left,
            Direction::Right,
        ];
        let mut best = Direction::None;
        let mut best_score = f32::NEG_INFINITY;

        let nearest_dot = self
            .world
            .dots
            .iter()
            .min_by_key(|(dx, dy)| manhattan(x, y, *dx, *dy))
            .cloned();

        for dir in dirs {
            let (nx, ny) = offset(x, y, dir);
            if !self.can_move_between(x, y, nx, ny) {
                continue;
            }
            let mut score = 0.0;
            if self.world.dots.contains(&(nx, ny)) {
                score += 12.0;
            }
            if let Some((dx, dy)) = nearest_dot {
                let before = manhattan(x, y, dx, dy);
                let after = manhattan(nx, ny, dx, dy);
                score += (before - after) as f32 * 0.9;
            }
            if let Some(ghost_dist) = self.distance_to_nearest_ghost(nx, ny) {
                score += ghost_dist as f32 * 0.15;
            }
            score += self.rng.next_f32() * 0.4;

            if score > best_score {
                best_score = score;
                best = dir;
            }
        }

        if best == Direction::None {
            random_direction(&mut self.rng)
        } else {
            best
        }
    }

    fn choose_escape_direction(&mut self, x: i32, y: i32) -> Direction {
        let dirs = [
            Direction::Up,
            Direction::Down,
            Direction::Left,
            Direction::Right,
        ];
        let mut best = Direction::None;
        let mut best_dist = i32::MIN;
        for dir in dirs {
            let (nx, ny) = offset(x, y, dir);
            if !self.can_move_between(x, y, nx, ny) {
                continue;
            }
            let dist = self.distance_to_nearest_ghost(nx, ny).unwrap_or(99);
            if dist > best_dist {
                best_dist = dist;
                best = dir;
            }
        }
        if best == Direction::None {
            random_direction(&mut self.rng)
        } else {
            best
        }
    }

    fn choose_chase_direction(&mut self, x: i32, y: i32) -> Direction {
        if let Some(ghost) = self
            .ghosts
            .iter()
            .min_by_key(|ghost| manhattan(x, y, ghost.view.x, ghost.view.y))
        {
            return self.choose_toward_direction(x, y, ghost.view.x, ghost.view.y);
        }
        random_direction(&mut self.rng)
    }

    fn choose_toward_direction(&mut self, x: i32, y: i32, tx: i32, ty: i32) -> Direction {
        let mut candidates = [
            (Direction::Up, manhattan(x, y - 1, tx, ty)),
            (Direction::Down, manhattan(x, y + 1, tx, ty)),
            (Direction::Left, manhattan(x - 1, y, tx, ty)),
            (Direction::Right, manhattan(x + 1, y, tx, ty)),
        ];
        candidates.sort_by(|a, b| {
            let cmp = a.1.cmp(&b.1);
            if cmp == Ordering::Equal {
                Ordering::Equal
            } else {
                cmp
            }
        });

        for (dir, _) in candidates {
            let (nx, ny) = offset(x, y, dir);
            if self.can_move_between(x, y, nx, ny) {
                return dir;
            }
        }
        random_direction(&mut self.rng)
    }

    fn advance_player_one_cell(&mut self, idx: usize) {
        let desired = self.players[idx].desired_dir;
        let from_x = self.players[idx].view.x;
        let from_y = self.players[idx].view.y;
        let (dx, dy) = offset(from_x, from_y, desired);
        if desired != Direction::None && self.can_move_between(from_x, from_y, dx, dy) {
            self.players[idx].view.x = dx;
            self.players[idx].view.y = dy;
            self.players[idx].view.dir = desired;
            return;
        }

        let current = self.players[idx].view.dir;
        let (cx, cy) = offset(from_x, from_y, current);
        if current != Direction::None && self.can_move_between(from_x, from_y, cx, cy) {
            self.players[idx].view.x = cx;
            self.players[idx].view.y = cy;
            return;
        }

        let fallback = random_direction(&mut self.rng);
        let (fx, fy) = offset(from_x, from_y, fallback);
        if self.can_move_between(from_x, from_y, fx, fy) {
            self.players[idx].view.x = fx;
            self.players[idx].view.y = fy;
            self.players[idx].view.dir = fallback;
        } else {
            self.players[idx].view.dir = Direction::None;
        }
    }

    fn apply_player_pickups(&mut self, idx: usize, now_ms: u64) {
        let x = self.players[idx].view.x;
        let y = self.players[idx].view.y;

        if self.world.dots.remove(&(x, y)) {
            self.players[idx].view.score += 10;
            self.players[idx].stats.dots += 1;
            self.players[idx].view.gauge += 1;
            if self.players[idx].view.gauge >= DOTS_FOR_AWAKEN {
                self.players[idx].view.gauge -= DOTS_FOR_AWAKEN;
                self.players[idx].view.stocks =
                    (self.players[idx].view.stocks + 1).min(MAX_AWAKEN_STOCK);
            }

            if let Some(sector_id) = self.get_sector_id(x, y) {
                if let Some(sector) = self.world.sectors.get_mut(sector_id) {
                    sector.view.dot_count = (sector.view.dot_count - 1).max(0);
                    sector.view.discovered = true;
                }
            }
            self.events.push(RuntimeEvent::DotEaten {
                x,
                y,
                by: self.players[idx].view.id.clone(),
            });
        }

        let key = key_of(x, y);
        if let Some(pellet) = self.world.power_pellets.get_mut(&key) {
            if pellet.active {
                pellet.active = false;
                pellet.respawn_at = now_ms + POWER_PELLET_RESPAWN_MS;
                self.players[idx].view.state = PlayerState::Power;
                self.players[idx].view.power_until = now_ms + POWER_DURATION_MS;
                self.events.push(RuntimeEvent::PelletTaken { key });
            }
        }
    }

    fn resolve_player_rescues(&mut self, now_ms: u64) {
        let down_indices: Vec<usize> = self
            .players
            .iter()
            .enumerate()
            .filter(|(_, p)| p.view.state == PlayerState::Down)
            .map(|(idx, _)| idx)
            .collect();
        for down_idx in down_indices {
            let x = self.players[down_idx].view.x;
            let y = self.players[down_idx].view.y;
            let rescuer_idx = self
                .players
                .iter()
                .enumerate()
                .find(|(idx, p)| {
                    *idx != down_idx
                        && p.view.state != PlayerState::Down
                        && p.view.x == x
                        && p.view.y == y
                })
                .map(|(idx, _)| idx);
            if let Some(rescuer_idx) = rescuer_idx {
                let rescuer_id = self.players[rescuer_idx].view.id.clone();
                self.players[rescuer_idx].view.score += 80;
                self.players[rescuer_idx].stats.rescues += 1;
                self.revived_player(down_idx, now_ms, false, rescuer_id);
            }
        }
    }

    fn auto_respawn(&mut self, idx: usize, now_ms: u64) {
        self.players[idx].view.gauge = 0;
        self.players[idx].view.stocks = (self.players[idx].view.stocks - 1).max(0);
        let player_id = self.players[idx].view.id.clone();
        self.revived_player(idx, now_ms, true, player_id);
    }

    fn revived_player(&mut self, idx: usize, now_ms: u64, auto: bool, by: String) {
        let pos = self.pick_respawn_point(idx);
        self.players[idx].view.x = pos.x;
        self.players[idx].view.y = pos.y;
        self.players[idx].view.state = PlayerState::Normal;
        self.players[idx].view.down_since = None;
        self.players[idx].view.power_until = 0;
        self.players[idx].view.dir = Direction::None;
        self.players[idx].remote_revive_grace_until = now_ms + AUTO_RESPAWN_GRACE_MS;
        self.events.push(RuntimeEvent::PlayerRevived {
            player_id: self.players[idx].view.id.clone(),
            by,
            auto,
        });
    }

    fn pick_respawn_point(&mut self, idx: usize) -> Vec2 {
        let player_id = self.players[idx].view.id.clone();
        let spawn = self.players[idx].spawn;
        if self.is_safe_respawn_cell(spawn, &player_id) {
            return spawn;
        }
        let safe_cells: Vec<Vec2> = self
            .world
            .player_spawn_cells
            .iter()
            .cloned()
            .filter(|cell| self.is_safe_respawn_cell(*cell, &player_id))
            .collect();
        if safe_cells.is_empty() {
            spawn
        } else {
            safe_cells[self.rng.pick_index(safe_cells.len())]
        }
    }

    fn is_safe_respawn_cell(&self, cell: Vec2, player_id: &str) -> bool {
        if self.has_ghost_at(cell.x, cell.y) {
            return false;
        }
        if self.players.iter().any(|p| {
            p.view.id != player_id
                && p.view.state != PlayerState::Down
                && p.view.x == cell.x
                && p.view.y == cell.y
        }) {
            return false;
        }
        if is_gate_cell_or_switch(&self.world.gates, cell.x, cell.y) {
            return false;
        }
        if let Some(nearest_ghost) = self.distance_to_nearest_ghost(cell.x, cell.y) {
            if nearest_ghost <= 2 {
                return false;
            }
        }
        true
    }

    fn respawn_dot_in_sector(&mut self, sector_id: usize) -> bool {
        if sector_id >= self.world.sectors.len() {
            return false;
        }
        let candidates = self.world.sectors[sector_id].respawn_candidates.clone();
        if candidates.is_empty() {
            return false;
        }

        for _ in 0..30 {
            let idx = self.rng.pick_index(candidates.len());
            let cell = candidates[idx];
            if !self.is_valid_dot_respawn_cell(sector_id, cell.x, cell.y) {
                continue;
            }
            self.world.dots.insert((cell.x, cell.y));
            self.world.sectors[sector_id].view.dot_count += 1;
            self.events.push(RuntimeEvent::DotRespawned {
                x: cell.x,
                y: cell.y,
            });
            return true;
        }

        for cell in candidates {
            if !self.is_valid_dot_respawn_cell(sector_id, cell.x, cell.y) {
                continue;
            }
            self.world.dots.insert((cell.x, cell.y));
            self.world.sectors[sector_id].view.dot_count += 1;
            self.events.push(RuntimeEvent::DotRespawned {
                x: cell.x,
                y: cell.y,
            });
            return true;
        }
        false
    }

    fn is_valid_dot_respawn_cell(&self, sector_id: usize, x: i32, y: i32) -> bool {
        if !is_walkable(&self.world, x, y) {
            return false;
        }
        if self.get_sector_id(x, y) != Some(sector_id) {
            return false;
        }
        if self.world.dots.contains(&(x, y)) {
            return false;
        }
        if self.world.power_pellets.contains_key(&key_of(x, y)) {
            return false;
        }
        if is_gate_cell_or_switch(&self.world.gates, x, y) {
            return false;
        }
        true
    }

    fn capture_sector(&mut self, sector_id: usize, now_ms: u64) {
        if let Some(sector) = self.world.sectors.get_mut(sector_id) {
            sector.view.captured = true;
            sector.captured_at = now_ms;
            sector.regen_accumulator = 0.0;
            self.events.push(RuntimeEvent::SectorCaptured { sector_id });
            self.timeline.push(TimelineEvent {
                at_ms: self.elapsed_ms,
                label: format!("エリア{}制覇", sector_id),
            });
        }

        let width = self.world.width;
        let height = self.world.height;
        let sector_size = self.world.sector_size;
        let side = self.world.side;
        for player in &mut self.players {
            let player_sector_id = sector_id_from_coords(
                player.view.x,
                player.view.y,
                width,
                height,
                sector_size,
                side,
            );
            if player.view.state != PlayerState::Down && player_sector_id == Some(sector_id) {
                player.view.score += 300;
                player.stats.captures += 1;
            }
        }
    }

    fn count_ghost_by_sector_and_type(&self, sector_id: usize, ghost_type: GhostType) -> usize {
        self.ghosts
            .iter()
            .filter(|ghost| ghost.view.ghost_type == ghost_type)
            .filter(|ghost| self.get_sector_id(ghost.view.x, ghost.view.y) == Some(sector_id))
            .count()
    }

    fn spawn_initial_ghosts(&mut self) {
        let count = get_initial_ghost_count(self.player_count)
            .min(self.max_ghosts)
            .max(4);
        for _ in 0..count {
            self.spawn_ghost(self.started_at_ms, 0.0);
        }
    }

    fn spawn_ghost(&mut self, _now_ms: u64, capture_ratio: f32) {
        if self.world.ghost_spawn_cells.is_empty() {
            return;
        }
        let candidate_spawns: Vec<Vec2> = self
            .world
            .ghost_spawn_cells
            .iter()
            .cloned()
            .filter(|spawn| {
                self.players
                    .iter()
                    .all(|player| manhattan(spawn.x, spawn.y, player.view.x, player.view.y) >= 5)
            })
            .collect();
        let spawn_source = if candidate_spawns.is_empty() {
            self.world.ghost_spawn_cells.clone()
        } else {
            candidate_spawns
        };
        let spawn = spawn_source[self.rng.pick_index(spawn_source.len())];
        let ghost_type = pick_ghost_type(capture_ratio, &mut self.rng);
        let id = self.make_id("ghost");
        let hp = if ghost_type == GhostType::Boss { 3 } else { 1 };
        self.ghosts.push(GhostInternal {
            view: GhostView {
                id: id.clone(),
                x: spawn.x,
                y: spawn.y,
                dir: random_direction(&mut self.rng),
                ghost_type,
                hp,
                stunned_until: 0,
            },
            move_buffer: 0.0,
        });

        if ghost_type == GhostType::Boss {
            self.events.push(RuntimeEvent::BossSpawned { ghost_id: id });
        }
    }

    fn respawn_ghost(&mut self, ghost_idx: usize) {
        if ghost_idx >= self.ghosts.len() || self.world.ghost_spawn_cells.is_empty() {
            return;
        }
        let spawn =
            self.world.ghost_spawn_cells[self.rng.pick_index(self.world.ghost_spawn_cells.len())];
        let capture_ratio = self.capture_ratio();
        let ghost_type = pick_ghost_type(capture_ratio, &mut self.rng);
        self.ghosts[ghost_idx].view.x = spawn.x;
        self.ghosts[ghost_idx].view.y = spawn.y;
        self.ghosts[ghost_idx].view.ghost_type = ghost_type;
        self.ghosts[ghost_idx].view.dir = random_direction(&mut self.rng);
        self.ghosts[ghost_idx].view.hp = if ghost_type == GhostType::Boss { 3 } else { 1 };
        self.ghosts[ghost_idx].view.stunned_until = 0;
    }

    fn down_player(&mut self, player_idx: usize, now_ms: u64) {
        if self.players[player_idx].view.state == PlayerState::Down {
            return;
        }
        self.players[player_idx].view.state = PlayerState::Down;
        self.players[player_idx].view.down_since = Some(now_ms);
        self.players[player_idx].view.dir = Direction::None;
        self.players[player_idx].move_buffer = 0.0;
        self.events.push(RuntimeEvent::PlayerDown {
            player_id: self.players[player_idx].view.id.clone(),
        });
    }

    fn can_move_between(&self, from_x: i32, from_y: i32, to_x: i32, to_y: i32) -> bool {
        if !is_walkable(&self.world, to_x, to_y) {
            return false;
        }
        for gate in &self.world.gates {
            if gate.open {
                continue;
            }
            let crosses_closed_gate =
                (gate.a.x == from_x && gate.a.y == from_y && gate.b.x == to_x && gate.b.y == to_y)
                    || (gate.b.x == from_x
                        && gate.b.y == from_y
                        && gate.a.x == to_x
                        && gate.a.y == to_y);
            if crosses_closed_gate {
                return false;
            }
        }
        true
    }

    fn try_move_ghost(&mut self, ghost_idx: usize, dir: Direction) -> bool {
        if ghost_idx >= self.ghosts.len() {
            return false;
        }
        let (nx, ny) = offset(
            self.ghosts[ghost_idx].view.x,
            self.ghosts[ghost_idx].view.y,
            dir,
        );
        if dir != Direction::None
            && self.can_move_between(
                self.ghosts[ghost_idx].view.x,
                self.ghosts[ghost_idx].view.y,
                nx,
                ny,
            )
        {
            self.ghosts[ghost_idx].view.x = nx;
            self.ghosts[ghost_idx].view.y = ny;
            self.ghosts[ghost_idx].view.dir = dir;
            return true;
        }

        let fallback = random_direction(&mut self.rng);
        let (fx, fy) = offset(
            self.ghosts[ghost_idx].view.x,
            self.ghosts[ghost_idx].view.y,
            fallback,
        );
        if self.can_move_between(
            self.ghosts[ghost_idx].view.x,
            self.ghosts[ghost_idx].view.y,
            fx,
            fy,
        ) {
            self.ghosts[ghost_idx].view.x = fx;
            self.ghosts[ghost_idx].view.y = fy;
            self.ghosts[ghost_idx].view.dir = fallback;
            return true;
        }
        false
    }

    fn get_sector_id(&self, x: i32, y: i32) -> Option<usize> {
        if x < 0 || y < 0 || x >= self.world.width || y >= self.world.height {
            return None;
        }
        let col = x / self.world.sector_size;
        let row = y / self.world.sector_size;
        Some((row * self.world.side + col) as usize)
    }

    fn distance_to_nearest_ghost(&self, x: i32, y: i32) -> Option<i32> {
        self.ghosts
            .iter()
            .map(|ghost| manhattan(x, y, ghost.view.x, ghost.view.y))
            .min()
    }

    fn has_ghost_at(&self, x: i32, y: i32) -> bool {
        self.ghosts
            .iter()
            .any(|ghost| ghost.view.x == x && ghost.view.y == y)
    }

    fn make_id(&mut self, prefix: &str) -> String {
        let id = format!("{}_{}", prefix, self.next_id_counter);
        self.next_id_counter = self.next_id_counter.saturating_add(1);
        id
    }
}

fn now_ms() -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    now as u64
}

fn manhattan(ax: i32, ay: i32, bx: i32, by: i32) -> i32 {
    (ax - bx).abs() + (ay - by).abs()
}

fn offset(x: i32, y: i32, dir: Direction) -> (i32, i32) {
    match dir {
        Direction::Up => (x, y - 1),
        Direction::Down => (x, y + 1),
        Direction::Left => (x - 1, y),
        Direction::Right => (x + 1, y),
        Direction::None => (x, y),
    }
}

fn sector_id_from_coords(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    sector_size: i32,
    side: i32,
) -> Option<usize> {
    if x < 0 || y < 0 || x >= width || y >= height {
        return None;
    }
    let col = x / sector_size;
    let row = y / sector_size;
    Some((row * side + col) as usize)
}

fn random_direction(rng: &mut Rng) -> Direction {
    match rng.int(0, 3) {
        0 => Direction::Up,
        1 => Direction::Down,
        2 => Direction::Left,
        _ => Direction::Right,
    }
}

fn pick_ghost_type(capture_ratio: f32, rng: &mut Rng) -> GhostType {
    let roll = rng.next_f32();
    if capture_ratio < 0.3 {
        if roll < 0.75 {
            return GhostType::Random;
        }
        return GhostType::Chaser;
    }
    if capture_ratio < 0.6 {
        if roll < 0.3 {
            return GhostType::Random;
        }
        if roll < 0.55 {
            return GhostType::Chaser;
        }
        if roll < 0.8 {
            return GhostType::Patrol;
        }
        return GhostType::Pincer;
    }
    if capture_ratio < 0.9 {
        if roll < 0.2 {
            return GhostType::Random;
        }
        if roll < 0.4 {
            return GhostType::Chaser;
        }
        if roll < 0.6 {
            return GhostType::Patrol;
        }
        if roll < 0.8 {
            return GhostType::Pincer;
        }
        return GhostType::Invader;
    }
    if roll < 0.1 {
        return GhostType::Random;
    }
    if roll < 0.25 {
        return GhostType::Chaser;
    }
    if roll < 0.5 {
        return GhostType::Pincer;
    }
    if roll < 0.8 {
        return GhostType::Invader;
    }
    GhostType::Boss
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::constants::TICK_MS;
    use crate::engine::{GameEngine, GameEngineOptions};
    use crate::rng::Rng;
    use crate::types::{
        Difficulty, Direction, GateState, PlayerState, RuntimeEvent, StartPlayer, Vec2,
    };

    fn make_players(count: usize) -> Vec<StartPlayer> {
        (0..count)
            .map(|idx| StartPlayer {
                id: format!("p{}", idx + 1),
                name: format!("P{}", idx + 1),
                reconnect_token: format!("token_{}", idx + 1),
                connected: false,
            })
            .collect()
    }

    fn set_floor(engine: &mut GameEngine, x: i32, y: i32) {
        let row = engine
            .world
            .tiles
            .get_mut(y as usize)
            .expect("row in bounds")
            .clone();
        let mut bytes = row.into_bytes();
        bytes[x as usize] = b'.';
        *engine
            .world
            .tiles
            .get_mut(y as usize)
            .expect("row in bounds") = String::from_utf8(bytes).expect("valid utf8 row");
    }

    #[test]
    fn same_seed_produces_same_progression() {
        let players = make_players(10);
        let mut a = GameEngine::new(
            players.clone(),
            Difficulty::Normal,
            424_242,
            GameEngineOptions {
                time_limit_ms_override: Some(120_000),
            },
        );
        let mut b = GameEngine::new(
            players,
            Difficulty::Normal,
            424_242,
            GameEngineOptions {
                time_limit_ms_override: Some(120_000),
            },
        );

        for _ in 0..400 {
            a.step(TICK_MS);
            b.step(TICK_MS);
            let sa = a.build_snapshot(false);
            let sb = b.build_snapshot(false);

            assert_eq!(sa.capture_ratio.to_bits(), sb.capture_ratio.to_bits());
            assert_eq!(sa.players.len(), sb.players.len());
            assert_eq!(sa.ghosts.len(), sb.ghosts.len());

            for (pa, pb) in sa.players.iter().zip(sb.players.iter()) {
                assert_eq!(pa.id, pb.id);
                assert_eq!(pa.x, pb.x);
                assert_eq!(pa.y, pb.y);
                assert_eq!(pa.state as u8, pb.state as u8);
                assert_eq!(pa.score, pb.score);
            }
            for (ga, gb) in sa.ghosts.iter().zip(sb.ghosts.iter()) {
                assert_eq!(ga.id, gb.id);
                assert_eq!(ga.x, gb.x);
                assert_eq!(ga.y, gb.y);
                assert_eq!(ga.ghost_type as u8, gb.ghost_type as u8);
                assert_eq!(ga.hp, gb.hp);
            }

            if a.is_ended() || b.is_ended() {
                assert_eq!(a.is_ended(), b.is_ended());
                break;
            }
        }
    }

    #[test]
    fn swap_collision_downs_player() {
        let mut engine = GameEngine::new(
            make_players(1),
            Difficulty::Normal,
            100,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        engine.ghosts.truncate(1);
        assert_eq!(engine.ghosts.len(), 1);

        let player_id = engine.players[0].view.id.clone();
        let ghost_id = engine.ghosts[0].view.id.clone();
        engine.players[0].view.state = PlayerState::Normal;
        engine.players[0].view.down_since = None;
        engine.players[0].remote_revive_grace_until = 0;
        engine.players[0].view.x = 11;
        engine.players[0].view.y = 10;
        engine.players[0].view.dir = Direction::Right;
        engine.ghosts[0].view.x = 10;
        engine.ghosts[0].view.y = 10;

        let mut player_before = BTreeMap::new();
        player_before.insert(player_id, (10, 10));
        let mut ghost_before = BTreeMap::new();
        ghost_before.insert(ghost_id, (11, 10));

        engine.resolve_ghost_collisions(
            engine.started_at_ms + 1_000,
            &player_before,
            &ghost_before,
        );
        assert_eq!(engine.players[0].view.state as u8, PlayerState::Down as u8);
    }

    #[test]
    fn build_snapshot_drains_events_when_requested() {
        let mut engine = GameEngine::new(
            make_players(1),
            Difficulty::Normal,
            333,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        engine.events.push(RuntimeEvent::Toast {
            message: "test".to_string(),
        });

        let first = engine.build_snapshot(true);
        let second = engine.build_snapshot(true);
        assert_eq!(first.events.len(), 1);
        assert_eq!(second.events.len(), 0);
    }

    #[test]
    fn closed_gate_blocks_crossing_but_allows_endpoint_entry() {
        let mut engine = GameEngine::new(
            make_players(1),
            Difficulty::Normal,
            444,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );

        set_floor(&mut engine, 4, 5);
        set_floor(&mut engine, 5, 5);
        set_floor(&mut engine, 6, 5);
        set_floor(&mut engine, 5, 4);
        set_floor(&mut engine, 6, 4);

        engine.world.gates.clear();
        engine.world.gates.push(GateState {
            id: "gate_test".to_string(),
            a: Vec2 { x: 5, y: 5 },
            b: Vec2 { x: 6, y: 5 },
            switch_a: Vec2 { x: 5, y: 4 },
            switch_b: Vec2 { x: 6, y: 4 },
            open: false,
            permanent: false,
        });

        assert!(engine.can_move_between(4, 5, 5, 5));
        assert!(!engine.can_move_between(5, 5, 6, 5));
    }

    #[test]
    fn respawn_dot_fallback_scans_all_candidates() {
        let mut engine = GameEngine::new(
            make_players(5),
            Difficulty::Normal,
            555,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );

        let sector_id = engine
            .world
            .sectors
            .iter()
            .position(|sector| sector.respawn_candidates.len() >= 2)
            .expect("at least one sector has respawn candidates");
        let valid = engine.world.sectors[sector_id].respawn_candidates[0];
        let invalid = engine.world.sectors[sector_id].respawn_candidates[1];

        engine.world.dots.insert((invalid.x, invalid.y));
        engine.world.dots.remove(&(valid.x, valid.y));

        let mut forced_candidates = vec![invalid; 99];
        forced_candidates.push(valid);
        engine.world.sectors[sector_id].respawn_candidates = forced_candidates;

        let seed = (0..10_000u32)
            .find(|seed| {
                let mut rng = Rng::new(*seed);
                (0..30).all(|_| rng.pick_index(100) != 99)
            })
            .expect("find deterministic seed for random-miss phase");
        engine.rng = Rng::new(seed);

        let respawned = engine.respawn_dot_in_sector(sector_id);
        assert!(respawned);
        assert!(engine.world.dots.contains(&(valid.x, valid.y)));
    }

    #[test]
    fn events_are_preserved_until_snapshot_drains() {
        let mut engine = GameEngine::new(
            make_players(2),
            Difficulty::Normal,
            777,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        engine.events.push(RuntimeEvent::Toast {
            message: "carry".to_string(),
        });

        engine.step(TICK_MS);
        let snapshot = engine.build_snapshot(true);
        let has_carry = snapshot
            .events
            .iter()
            .any(|event| matches!(event, RuntimeEvent::Toast { message } if message == "carry"));
        assert!(has_carry);
    }

    #[test]
    fn ghost_population_adjusts_once_per_second() {
        let mut engine = GameEngine::new(
            make_players(5),
            Difficulty::Normal,
            888,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        for player in &mut engine.players {
            player.view.state = PlayerState::Power;
            player.view.power_until = u64::MAX;
        }
        engine.ghosts.truncate(1);
        let before = engine.ghosts.len();

        engine.step(TICK_MS);
        assert_eq!(engine.ghosts.len(), before);

        for _ in 1..20 {
            engine.step(TICK_MS);
        }
        assert!(engine.ghosts.len() > before);
    }

    #[test]
    fn auto_respawn_applies_gauge_and_stock_cost() {
        let mut engine = GameEngine::new(
            make_players(1),
            Difficulty::Normal,
            999,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        engine.players[0].view.state = PlayerState::Down;
        engine.players[0].view.down_since = Some(engine.started_at_ms);
        engine.players[0].view.gauge = 35;
        engine.players[0].view.stocks = 2;

        engine.auto_respawn(0, engine.started_at_ms + 10_000);
        assert_eq!(
            engine.players[0].view.state as u8,
            PlayerState::Normal as u8
        );
        assert_eq!(engine.players[0].view.gauge, 0);
        assert_eq!(engine.players[0].view.stocks, 1);
    }
}
