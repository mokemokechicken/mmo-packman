use super::*;

impl GameEngine {
    pub(super) fn spawn_initial_ghosts(&mut self) {
        let count = get_initial_ghost_count(self.player_count)
            .min(self.max_ghosts)
            .max(4);
        for _ in 0..count {
            self.spawn_ghost(self.started_at_ms, 0.0);
        }
    }

    pub(super) fn spawn_ghost(&mut self, _now_ms: u64, capture_ratio: f32) {
        let Some(spawn) = self.pick_ghost_spawn_position(None) else {
            return;
        };
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

    pub(super) fn respawn_ghost(&mut self, ghost_idx: usize) {
        if ghost_idx >= self.ghosts.len() {
            return;
        }
        let spawn = self
            .pick_ghost_spawn_position(Some(ghost_idx))
            .unwrap_or(Vec2 {
                x: self.ghosts[ghost_idx].view.x,
                y: self.ghosts[ghost_idx].view.y,
            });
        let capture_ratio = self.capture_ratio();
        let ghost_type = pick_ghost_type(capture_ratio, &mut self.rng);
        self.ghosts[ghost_idx].view.x = spawn.x;
        self.ghosts[ghost_idx].view.y = spawn.y;
        self.ghosts[ghost_idx].view.ghost_type = ghost_type;
        self.ghosts[ghost_idx].view.dir = random_direction(&mut self.rng);
        self.ghosts[ghost_idx].view.hp = if ghost_type == GhostType::Boss { 3 } else { 1 };
        self.ghosts[ghost_idx].view.stunned_until = 0;
    }

    pub(super) fn is_cell_occupied_by_other_ghost(
        &self,
        x: i32,
        y: i32,
        exclude_ghost_idx: Option<usize>,
    ) -> bool {
        self.ghosts.iter().enumerate().any(|(idx, ghost)| {
            Some(idx) != exclude_ghost_idx && ghost.view.x == x && ghost.view.y == y
        })
    }

    pub(super) fn pick_ghost_spawn_position(
        &mut self,
        exclude_ghost_idx: Option<usize>,
    ) -> Option<Vec2> {
        if self.world.ghost_spawn_cells.is_empty() {
            return None;
        }
        let mut spawn_sources: Vec<Vec2> = self
            .world
            .ghost_spawn_cells
            .iter()
            .cloned()
            .filter(|spawn| {
                !self.is_cell_occupied_by_other_ghost(spawn.x, spawn.y, exclude_ghost_idx)
                    && self.players.iter().all(|player| {
                        player.view.state == PlayerState::Down
                            || manhattan(spawn.x, spawn.y, player.view.x, player.view.y) >= 5
                    })
            })
            .collect();
        if spawn_sources.is_empty() {
            spawn_sources = self.world.ghost_spawn_cells.clone();
        }
        if spawn_sources.is_empty() {
            return None;
        }

        for _ in 0..24 {
            let anchor = spawn_sources[self.rng.pick_index(spawn_sources.len())];
            let dx = self.rng.int(-2, 2);
            let dy = self.rng.int(-2, 2);
            let tx = (anchor.x + dx).clamp(1, self.world.width - 2);
            let ty = (anchor.y + dy).clamp(1, self.world.height - 2);
            if !is_walkable(&self.world, tx, ty) {
                continue;
            }
            if self.is_cell_occupied_by_other_ghost(tx, ty, exclude_ghost_idx) {
                continue;
            }
            let near_player = self.players.iter().any(|player| {
                player.view.state != PlayerState::Down
                    && manhattan(tx, ty, player.view.x, player.view.y) < 3
            });
            if near_player {
                continue;
            }
            return Some(Vec2 { x: tx, y: ty });
        }

        for anchor in spawn_sources {
            if !is_walkable(&self.world, anchor.x, anchor.y) {
                continue;
            }
            if self.is_cell_occupied_by_other_ghost(anchor.x, anchor.y, exclude_ghost_idx) {
                continue;
            }
            return Some(anchor);
        }

        None
    }
}
