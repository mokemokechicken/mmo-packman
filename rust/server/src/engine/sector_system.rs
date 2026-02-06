use super::*;

impl GameEngine {
    pub(super) fn update_sector_control(&mut self, dt_ms: u64, now_ms: u64) {
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

    pub(super) fn adjust_ghost_population(&mut self, now_ms: u64) {
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

    pub(super) fn check_game_over(&mut self, now_ms: u64) {
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

    pub(super) fn emit_progress_milestones(&mut self) {
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

    pub(super) fn capture_ratio(&self) -> f32 {
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

    pub(super) fn choose_dot_direction(&mut self, x: i32, y: i32) -> Direction {
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

    pub(super) fn find_rescue_target(&self, player_idx: usize) -> Option<(usize, i32)> {
        let player = self.players.get(player_idx)?;
        self.players
            .iter()
            .enumerate()
            .filter(|(idx, target)| *idx != player_idx && target.view.state == PlayerState::Down)
            .map(|(idx, target)| {
                (
                    idx,
                    manhattan(player.view.x, player.view.y, target.view.x, target.view.y),
                )
            })
            .min_by_key(|(_, dist)| *dist)
    }

    pub(super) fn choose_rescue_direction(
        &mut self,
        x: i32,
        y: i32,
        tx: i32,
        ty: i32,
    ) -> Direction {
        let dirs = [
            Direction::Up,
            Direction::Down,
            Direction::Left,
            Direction::Right,
        ];
        let mut best = Direction::None;
        let mut best_score = f32::NEG_INFINITY;

        for dir in dirs {
            let (nx, ny) = offset(x, y, dir);
            if !self.can_move_between(x, y, nx, ny) {
                continue;
            }
            let ghost_dist = self.distance_to_nearest_ghost(nx, ny).unwrap_or(99);
            if ghost_dist <= 1 && (nx != tx || ny != ty) {
                continue;
            }
            let mut score = -(manhattan(nx, ny, tx, ty) as f32) * 1.6;
            score += ghost_dist as f32 * 0.9;
            if ghost_dist <= 2 {
                score -= 8.0;
            }
            score += self.rng.next_f32() * 0.2;
            if score > best_score {
                best_score = score;
                best = dir;
            }
        }

        if best == Direction::None {
            self.choose_escape_direction(x, y)
        } else {
            best
        }
    }

    pub(super) fn choose_safe_dot_direction(&mut self, x: i32, y: i32) -> Direction {
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
            let ghost_dist = self.distance_to_nearest_ghost(nx, ny).unwrap_or(99);
            if ghost_dist <= 1 {
                continue;
            }

            let mut score = 0.0;
            if self.world.dots.contains(&(nx, ny)) {
                score += 14.0;
            }
            if let Some((dx, dy)) = nearest_dot {
                let before = manhattan(x, y, dx, dy);
                let after = manhattan(nx, ny, dx, dy);
                score += (before - after) as f32 * 1.0;
            }
            score += ghost_dist as f32 * 0.65;
            if ghost_dist <= 2 {
                score -= 7.0;
            }
            score += self.rng.next_f32() * 0.25;

            if score > best_score {
                best_score = score;
                best = dir;
            }
        }

        if best == Direction::None {
            self.choose_escape_direction(x, y)
        } else {
            best
        }
    }

    pub(super) fn choose_escape_direction(&mut self, x: i32, y: i32) -> Direction {
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

    pub(super) fn choose_chase_direction(&mut self, x: i32, y: i32) -> Direction {
        if let Some(ghost) = self
            .ghosts
            .iter()
            .min_by_key(|ghost| manhattan(x, y, ghost.view.x, ghost.view.y))
        {
            return self.choose_toward_direction(x, y, ghost.view.x, ghost.view.y);
        }
        random_direction(&mut self.rng)
    }

    pub(super) fn choose_toward_direction(
        &mut self,
        x: i32,
        y: i32,
        tx: i32,
        ty: i32,
    ) -> Direction {
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

    pub(super) fn advance_player_one_cell(&mut self, idx: usize) {
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

    pub(super) fn apply_player_pickups(&mut self, idx: usize, now_ms: u64) {
        let x = self.players[idx].view.x;
        let y = self.players[idx].view.y;

        if self.world.dots.remove(&(x, y)) {
            self.players[idx].view.score += 10;
            self.players[idx].stats.dots += 1;
            if self.players[idx].view.stocks < MAX_AWAKEN_STOCK {
                self.players[idx].view.gauge += 1;
                if self.players[idx].view.gauge >= DOTS_FOR_AWAKEN {
                    self.players[idx].view.stocks += 1;
                    self.players[idx].view.gauge = 0;
                }
            } else {
                self.players[idx].view.gauge = DOTS_FOR_AWAKEN;
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

    pub(super) fn resolve_player_rescues(&mut self, now_ms: u64) {
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

    pub(super) fn auto_respawn(&mut self, idx: usize, now_ms: u64) {
        self.players[idx].view.gauge = 0;
        self.players[idx].view.stocks = (self.players[idx].view.stocks - 1).max(0);
        let player_id = self.players[idx].view.id.clone();
        self.revived_player(idx, now_ms, true, player_id);
    }

    pub(super) fn revived_player(&mut self, idx: usize, now_ms: u64, auto: bool, by: String) {
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

    pub(super) fn pick_respawn_point(&mut self, idx: usize) -> Vec2 {
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

    pub(super) fn is_safe_respawn_cell(&self, cell: Vec2, player_id: &str) -> bool {
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

    pub(super) fn respawn_dot_in_sector(&mut self, sector_id: usize) -> bool {
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

    pub(super) fn is_valid_dot_respawn_cell(&self, sector_id: usize, x: i32, y: i32) -> bool {
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

    pub(super) fn capture_sector(&mut self, sector_id: usize, now_ms: u64) {
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

        let ghosts_in_sector: Vec<usize> = self
            .ghosts
            .iter()
            .enumerate()
            .filter(|(_, ghost)| self.get_sector_id(ghost.view.x, ghost.view.y) == Some(sector_id))
            .map(|(idx, _)| idx)
            .collect();
        for ghost_idx in ghosts_in_sector {
            self.respawn_ghost(ghost_idx);
        }
    }

    pub(super) fn count_ghost_by_sector_and_type(
        &self,
        sector_id: usize,
        ghost_type: GhostType,
    ) -> usize {
        self.ghosts
            .iter()
            .filter(|ghost| ghost.view.ghost_type == ghost_type)
            .filter(|ghost| self.get_sector_id(ghost.view.x, ghost.view.y) == Some(sector_id))
            .count()
    }
}
