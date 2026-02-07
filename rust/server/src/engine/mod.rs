use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};

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

mod sector_system;
mod spawn_system;
mod utils;

use self::utils::{
    manhattan, now_ms, offset, pick_ghost_type, random_direction, sector_id_from_coords,
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

            let speed = self.get_player_speed(idx, now_ms);

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

        self.players[player_idx].ai_think_at = now_ms + self.rng.int(90, 190) as u64;
        let player = self.players[player_idx].view.clone();
        let nearest_ghost = self.distance_to_nearest_ghost(player.x, player.y);
        let danger_threshold = if self.is_large_party_endgame_band() {
            2
        } else {
            4
        };
        let rescue_threat_threshold = if self.is_large_party_endgame_band() {
            2
        } else {
            3
        };
        let cautious_dot_threshold = if self.is_large_party_endgame_band() {
            3
        } else {
            7
        };

        if player.state == PlayerState::Power {
            self.players[player_idx].desired_dir = self.choose_chase_direction(player.x, player.y);
            return;
        }

        if let Some(dist) = nearest_ghost {
            if dist <= danger_threshold {
                if player.stocks > 0 && player.state != PlayerState::Power {
                    self.players[player_idx].awaken_requested = true;
                }
                self.players[player_idx].desired_dir =
                    self.choose_escape_direction(player.x, player.y);
                return;
            }
        }

        if let Some((down_idx, _)) = self.find_rescue_target(player_idx) {
            let down = self.players[down_idx].view.clone();
            let rescue_threat = self.distance_to_nearest_ghost(down.x, down.y).unwrap_or(99);
            if rescue_threat <= rescue_threat_threshold && player.stocks > 0 {
                self.players[player_idx].awaken_requested = true;
            }
            self.players[player_idx].desired_dir =
                self.choose_rescue_direction(player.x, player.y, down.x, down.y);
            return;
        }

        if nearest_ghost.unwrap_or(99) <= cautious_dot_threshold {
            self.players[player_idx].desired_dir =
                self.choose_safe_dot_direction(player.x, player.y);
            return;
        }

        self.players[player_idx].desired_dir = self.choose_dot_direction(player.x, player.y);
    }

    fn get_player_speed(&self, idx: usize, now_ms: u64) -> f32 {
        let mut speed = PLAYER_BASE_SPEED;
        let Some(player) = self.players.get(idx) else {
            return speed;
        };
        speed *= self.large_party_player_speed_multiplier();

        if let Some(sector_id) = self.get_sector_id(player.view.x, player.view.y) {
            if self
                .world
                .sectors
                .get(sector_id)
                .map(|sector| sector.view.captured)
                .unwrap_or(false)
            {
                speed *= PLAYER_CAPTURED_SPEED_MULTIPLIER;
            }
        }

        if now_ms < player.view.speed_buff_until {
            speed *= 1.3;
        }
        speed
    }

    fn is_large_party_endgame_band(&self) -> bool {
        (80..=100).contains(&self.player_count)
    }

    fn large_party_player_speed_multiplier(&self) -> f32 {
        if self.is_large_party_endgame_band() {
            1.5
        } else {
            1.0
        }
    }

    fn large_party_regen_relief_factor(&self) -> f32 {
        if self.is_large_party_endgame_band() {
            0.05
        } else {
            1.0
        }
    }

    fn large_party_ghost_target_profile(&self) -> (f32, f32, f32, f32) {
        if self.is_large_party_endgame_band() {
            (0.2, 0.45, 0.2, 0.6)
        } else {
            (0.5, 1.0, 0.7, 1.0)
        }
    }

    fn large_party_capture_threshold_ratio(&self) -> f32 {
        if self.is_large_party_endgame_band() {
            0.35
        } else {
            0.0
        }
    }

    fn large_party_loss_threshold_ratio(&self) -> f32 {
        if self.is_large_party_endgame_band() {
            0.45
        } else {
            0.05
        }
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::constants::{
        DOTS_FOR_AWAKEN, MAX_AWAKEN_STOCK, PLAYER_BASE_SPEED, PLAYER_CAPTURED_SPEED_MULTIPLIER,
        TICK_MS,
    };
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

    fn approx_eq(a: f32, b: f32, eps: f32) -> bool {
        (a - b).abs() <= eps
    }

    fn first_walkable_neighbor(engine: &GameEngine, x: i32, y: i32) -> (Direction, i32, i32) {
        for dir in [
            Direction::Up,
            Direction::Down,
            Direction::Left,
            Direction::Right,
        ] {
            let (nx, ny) = super::offset(x, y, dir);
            if engine.can_move_between(x, y, nx, ny) {
                return (dir, nx, ny);
            }
        }
        panic!("expected at least one walkable neighbor");
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
    fn ai_prefers_rescue_direction_when_teammate_is_downed() {
        let mut engine = GameEngine::new(
            make_players(2),
            Difficulty::Normal,
            2_001,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        engine.ghosts.clear();

        let start_x = engine.players[0].view.x;
        let start_y = engine.players[0].view.y;
        let (expected_dir, target_x, target_y) = first_walkable_neighbor(&engine, start_x, start_y);
        engine.players[1].view.state = PlayerState::Down;
        engine.players[1].view.down_since = Some(engine.started_at_ms);
        engine.players[1].view.x = target_x;
        engine.players[1].view.y = target_y;
        engine.players[0].ai_think_at = 0;

        engine.update_player_ai(0, engine.started_at_ms + 1_000);
        assert_eq!(engine.players[0].desired_dir as u8, expected_dir as u8);
    }

    #[test]
    fn ai_requests_awaken_for_high_risk_rescue() {
        let mut engine = GameEngine::new(
            make_players(2),
            Difficulty::Normal,
            2_002,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        engine.ghosts.truncate(1);

        engine.players[0].view.x = 10;
        engine.players[0].view.y = 10;
        engine.players[0].view.stocks = 1;
        engine.players[0].view.state = PlayerState::Normal;
        engine.players[0].awaken_requested = false;
        engine.players[0].ai_think_at = 0;

        engine.players[1].view.state = PlayerState::Down;
        engine.players[1].view.down_since = Some(engine.started_at_ms);
        engine.players[1].view.x = 14;
        engine.players[1].view.y = 10;

        set_floor(&mut engine, 10, 10);
        set_floor(&mut engine, 11, 10);
        set_floor(&mut engine, 12, 10);
        set_floor(&mut engine, 13, 10);
        set_floor(&mut engine, 14, 10);
        set_floor(&mut engine, 15, 10);

        engine.ghosts[0].view.x = 15;
        engine.ghosts[0].view.y = 10;
        assert!(
            engine
                .distance_to_nearest_ghost(10, 10)
                .expect("ghost exists")
                > 3
        );
        assert!(
            engine
                .distance_to_nearest_ghost(14, 10)
                .expect("ghost exists")
                <= 3
        );

        engine.update_player_ai(0, engine.started_at_ms + 1_000);
        assert!(engine.players[0].awaken_requested);
    }

    #[test]
    fn ai_escapes_before_rescue_when_self_in_danger() {
        let mut engine = GameEngine::new(
            make_players(2),
            Difficulty::Normal,
            2_004,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        engine.ghosts.truncate(1);

        engine.players[0].view.x = 10;
        engine.players[0].view.y = 10;
        engine.players[0].view.stocks = 0;
        engine.players[0].view.state = PlayerState::Normal;
        engine.players[0].ai_think_at = 0;
        engine.players[1].view.state = PlayerState::Down;
        engine.players[1].view.down_since = Some(engine.started_at_ms);
        engine.players[1].view.x = 11;
        engine.players[1].view.y = 10;

        set_floor(&mut engine, 10, 10);
        set_floor(&mut engine, 9, 10);
        set_floor(&mut engine, 10, 9);
        set_floor(&mut engine, 10, 11);
        set_floor(&mut engine, 11, 10);
        engine.ghosts[0].view.x = 10;
        engine.ghosts[0].view.y = 11;

        let expected = engine.choose_escape_direction(10, 10);
        engine.update_player_ai(0, engine.started_at_ms + 1_000);
        assert_eq!(engine.players[0].desired_dir as u8, expected as u8);
    }

    #[test]
    fn ai_holds_position_when_already_on_downed_player() {
        let mut engine = GameEngine::new(
            make_players(2),
            Difficulty::Normal,
            2_006,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        engine.ghosts.clear();

        engine.players[0].view.x = 10;
        engine.players[0].view.y = 10;
        engine.players[0].view.state = PlayerState::Normal;
        engine.players[0].ai_think_at = 0;
        engine.players[1].view.state = PlayerState::Down;
        engine.players[1].view.down_since = Some(engine.started_at_ms);
        engine.players[1].view.x = 10;
        engine.players[1].view.y = 10;

        engine.update_player_ai(0, engine.started_at_ms + 1_000);
        assert_eq!(engine.players[0].desired_dir as u8, Direction::None as u8);
    }

    #[test]
    fn ai_power_state_keeps_chase_behavior() {
        let mut engine = GameEngine::new(
            make_players(1),
            Difficulty::Normal,
            2_005,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        engine.ghosts.truncate(1);

        engine.players[0].view.x = 10;
        engine.players[0].view.y = 10;
        engine.players[0].view.state = PlayerState::Power;
        engine.players[0].view.power_until = engine.started_at_ms + 10_000;
        engine.players[0].ai_think_at = 0;
        engine.ghosts[0].view.x = 12;
        engine.ghosts[0].view.y = 10;

        let expected = engine.choose_chase_direction(10, 10);
        engine.update_player_ai(0, engine.started_at_ms + 1_000);
        assert_eq!(engine.players[0].desired_dir as u8, expected as u8);
    }

    #[test]
    fn choose_safe_dot_direction_avoids_adjacent_ghost_cell() {
        let mut engine = GameEngine::new(
            make_players(1),
            Difficulty::Normal,
            2_003,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        engine.ghosts.truncate(1);

        let x = 10;
        let y = 10;
        engine.players[0].view.x = x;
        engine.players[0].view.y = y;
        set_floor(&mut engine, x, y);
        set_floor(&mut engine, x - 1, y);
        set_floor(&mut engine, x, y - 1);
        set_floor(&mut engine, x, y + 1);
        set_floor(&mut engine, x + 1, y);

        engine.world.dots.insert((x + 1, y));
        engine.ghosts[0].view.x = x + 1;
        engine.ghosts[0].view.y = y;

        let dir = engine.choose_safe_dot_direction(x, y);
        assert_ne!(dir as u8, Direction::Right as u8);
    }

    #[test]
    fn player_speed_depends_on_captured_sector_not_global_ratio() {
        let mut engine = GameEngine::new(
            make_players(1),
            Difficulty::Normal,
            889,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        let now_ms = engine.started_at_ms + 5_000;
        let player = &engine.players[0].view;
        let sector_id = engine
            .get_sector_id(player.x, player.y)
            .expect("player placed in sector");

        engine.players[0].view.speed_buff_until = 0;
        engine.world.sectors[sector_id].view.captured = false;
        let normal_speed = engine.get_player_speed(0, now_ms);
        assert!(approx_eq(normal_speed, PLAYER_BASE_SPEED, 0.0001));

        engine.world.sectors[sector_id].view.captured = true;
        let captured_speed = engine.get_player_speed(0, now_ms);
        assert!(approx_eq(
            captured_speed,
            PLAYER_BASE_SPEED * PLAYER_CAPTURED_SPEED_MULTIPLIER,
            0.0001
        ));

        engine.players[0].view.speed_buff_until = now_ms + 10_000;
        let boosted_speed = engine.get_player_speed(0, now_ms);
        assert!(approx_eq(
            boosted_speed,
            PLAYER_BASE_SPEED * PLAYER_CAPTURED_SPEED_MULTIPLIER * 1.3,
            0.0001
        ));
    }

    #[test]
    fn gauge_stays_full_when_stock_is_maxed() {
        let mut engine = GameEngine::new(
            make_players(1),
            Difficulty::Normal,
            890,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        let dot = engine
            .world
            .dots
            .iter()
            .next()
            .cloned()
            .expect("world has at least one dot");
        engine.players[0].view.x = dot.0;
        engine.players[0].view.y = dot.1;
        engine.players[0].view.stocks = MAX_AWAKEN_STOCK;
        engine.players[0].view.gauge = 0;

        engine.apply_player_pickups(0, engine.started_at_ms + 100);
        assert_eq!(engine.players[0].view.stocks, MAX_AWAKEN_STOCK);
        assert_eq!(engine.players[0].view.gauge, DOTS_FOR_AWAKEN);
    }

    #[test]
    fn large_party_profiles_are_applied_by_player_count() {
        let large = GameEngine::new(
            make_players(80),
            Difficulty::Normal,
            8_001,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        assert!(approx_eq(
            large.large_party_player_speed_multiplier(),
            1.5,
            0.0001
        ));
        assert!(approx_eq(large.large_party_regen_relief_factor(), 0.05, 0.0001));
        assert_eq!(
            large.large_party_ghost_target_profile(),
            (0.2, 0.45, 0.2, 0.6)
        );
        assert!(approx_eq(
            large.large_party_capture_threshold_ratio(),
            0.35,
            0.0001
        ));
        assert!(approx_eq(
            large.large_party_loss_threshold_ratio(),
            0.45,
            0.0001
        ));

        let medium = GameEngine::new(
            make_players(60),
            Difficulty::Normal,
            8_002,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        assert!(approx_eq(
            medium.large_party_player_speed_multiplier(),
            1.0,
            0.0001
        ));
        assert!(approx_eq(
            medium.large_party_regen_relief_factor(),
            1.0,
            0.0001
        ));
        assert_eq!(
            medium.large_party_ghost_target_profile(),
            (0.5, 1.0, 0.7, 1.0)
        );
        assert!(approx_eq(
            medium.large_party_capture_threshold_ratio(),
            0.0,
            0.0001
        ));
        assert!(approx_eq(
            medium.large_party_loss_threshold_ratio(),
            0.05,
            0.0001
        ));

        let small = GameEngine::new(
            make_players(5),
            Difficulty::Normal,
            8_003,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        assert!(approx_eq(
            small.large_party_player_speed_multiplier(),
            1.0,
            0.0001
        ));
        assert!(approx_eq(small.large_party_regen_relief_factor(), 1.0, 0.0001));
        assert_eq!(
            small.large_party_ghost_target_profile(),
            (0.5, 1.0, 0.7, 1.0)
        );
        assert!(approx_eq(
            small.large_party_capture_threshold_ratio(),
            0.0,
            0.0001
        ));
        assert!(approx_eq(
            small.large_party_loss_threshold_ratio(),
            0.05,
            0.0001
        ));

        let overflow = GameEngine::new(
            make_players(101),
            Difficulty::Normal,
            8_004,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        assert!(approx_eq(
            overflow.large_party_player_speed_multiplier(),
            1.0,
            0.0001
        ));
        assert!(approx_eq(
            overflow.large_party_regen_relief_factor(),
            1.0,
            0.0001
        ));
        assert_eq!(
            overflow.large_party_ghost_target_profile(),
            (0.5, 1.0, 0.7, 1.0)
        );
        assert!(approx_eq(
            overflow.large_party_capture_threshold_ratio(),
            0.0,
            0.0001
        ));
        assert!(approx_eq(
            overflow.large_party_loss_threshold_ratio(),
            0.05,
            0.0001
        ));
    }

    #[test]
    fn capture_sector_respawns_ghosts_inside_it() {
        let mut engine = GameEngine::new(
            make_players(2),
            Difficulty::Normal,
            891,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        assert!(!engine.ghosts.is_empty());

        let target_sector = engine
            .get_sector_id(engine.ghosts[0].view.x, engine.ghosts[0].view.y)
            .expect("ghost in sector");
        let fallback_spawn = engine
            .world
            .sectors
            .iter()
            .flat_map(|sector| sector.floor_cells.iter().copied())
            .find(|cell| engine.get_sector_id(cell.x, cell.y) != Some(target_sector))
            .expect("find floor cell in different sector");
        engine.world.ghost_spawn_cells = vec![fallback_spawn];

        engine.capture_sector(target_sector, engine.started_at_ms + 1_000);
        let still_inside = engine
            .ghosts
            .iter()
            .any(|ghost| engine.get_sector_id(ghost.view.x, ghost.view.y) == Some(target_sector));
        assert!(!still_inside);
    }

    #[test]
    fn large_party_ai_danger_threshold_starts_at_eighty_players() {
        let mut sixty = GameEngine::new(
            make_players(60),
            Difficulty::Normal,
            8_101,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        sixty.ghosts.truncate(1);
        sixty.players[0].view.x = 10;
        sixty.players[0].view.y = 10;
        sixty.players[0].view.state = PlayerState::Normal;
        sixty.players[0].view.stocks = 1;
        sixty.players[0].awaken_requested = false;
        sixty.players[0].ai_think_at = 0;
        sixty.ghosts[0].view.x = 13;
        sixty.ghosts[0].view.y = 10;
        sixty.update_player_ai(0, sixty.started_at_ms + 1_000);
        assert!(sixty.players[0].awaken_requested);

        let mut eighty = GameEngine::new(
            make_players(80),
            Difficulty::Normal,
            8_102,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        eighty.ghosts.truncate(1);
        eighty.players[0].view.x = 10;
        eighty.players[0].view.y = 10;
        eighty.players[0].view.state = PlayerState::Normal;
        eighty.players[0].view.stocks = 1;
        eighty.players[0].awaken_requested = false;
        eighty.players[0].ai_think_at = 0;
        eighty.ghosts[0].view.x = 13;
        eighty.ghosts[0].view.y = 10;
        eighty.update_player_ai(0, eighty.started_at_ms + 1_000);
        assert!(!eighty.players[0].awaken_requested);
    }

    #[test]
    fn large_party_capture_threshold_applies_only_in_endgame_band() {
        let mut band = GameEngine::new(
            make_players(80),
            Difficulty::Normal,
            8_103,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        let sector_id = 0usize;
        band.world.sectors[sector_id].view.captured = false;
        band.world.sectors[sector_id].view.total_dots = 20;
        band.world.sectors[sector_id].view.dot_count = 7;
        band.update_sector_control(TICK_MS, band.started_at_ms + TICK_MS);
        assert!(band.world.sectors[sector_id].view.captured);

        let mut below = GameEngine::new(
            make_players(79),
            Difficulty::Normal,
            8_108,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        below.world.sectors[sector_id].view.captured = false;
        below.world.sectors[sector_id].view.total_dots = 20;
        below.world.sectors[sector_id].view.dot_count = 7;
        below.update_sector_control(TICK_MS, below.started_at_ms + TICK_MS);

        assert!(!below.world.sectors[sector_id].view.captured);
    }

    #[test]
    fn large_party_loss_threshold_releases_sector_before_default_rule() {
        let mut engine = GameEngine::new(
            make_players(80),
            Difficulty::Normal,
            8_104,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        let sector_id = 0usize;
        engine.world.sectors[sector_id].view.captured = true;
        engine.world.sectors[sector_id].view.total_dots = 20;
        engine.world.sectors[sector_id].view.dot_count = 10;
        engine.world.sectors[sector_id].captured_at = engine.started_at_ms.saturating_sub(200_000);

        engine.update_sector_control(TICK_MS, engine.started_at_ms + TICK_MS);

        assert!(!engine.world.sectors[sector_id].view.captured);
        let lost_event = engine.events.iter().any(|event| {
            matches!(event, RuntimeEvent::SectorLost { sector_id: id } if *id == sector_id)
        });
        assert!(lost_event);
    }

    #[test]
    fn large_party_ghost_population_is_reduced_by_profile_target() {
        let mut engine = GameEngine::new(
            make_players(80),
            Difficulty::Normal,
            8_105,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        let before = engine.ghosts.len();
        engine.adjust_ghost_population(engine.started_at_ms + 1_000);
        assert_eq!(engine.ghosts.len(), before.saturating_sub(2));
    }

    #[test]
    fn large_party_population_profile_is_not_applied_below_eighty_players() {
        let mut below = GameEngine::new(
            make_players(79),
            Difficulty::Normal,
            8_106,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        below.ghosts.truncate(40);
        below.adjust_ghost_population(below.started_at_ms + 1_000);
        assert_eq!(below.ghosts.len(), 43);

        let mut band = GameEngine::new(
            make_players(80),
            Difficulty::Normal,
            8_107,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        band.ghosts.truncate(40);
        band.adjust_ghost_population(band.started_at_ms + 1_000);
        assert_eq!(band.ghosts.len(), 38);
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
