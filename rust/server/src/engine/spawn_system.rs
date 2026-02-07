use super::*;

impl GameEngine {
    fn boss_hp_for_player_count(player_count: usize) -> i32 {
        if player_count <= 2 {
            1
        } else if player_count <= 5 {
            2
        } else {
            3
        }
    }

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
        let ghost_type = pick_ghost_type(capture_ratio, self.player_count, &mut self.rng);
        let id = self.make_id("ghost");
        let hp = if ghost_type == GhostType::Boss {
            Self::boss_hp_for_player_count(self.player_count)
        } else {
            1
        };
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
        let ghost_type = pick_ghost_type(capture_ratio, self.player_count, &mut self.rng);
        self.ghosts[ghost_idx].view.x = spawn.x;
        self.ghosts[ghost_idx].view.y = spawn.y;
        self.ghosts[ghost_idx].view.ghost_type = ghost_type;
        self.ghosts[ghost_idx].view.dir = random_direction(&mut self.rng);
        self.ghosts[ghost_idx].view.hp = if ghost_type == GhostType::Boss {
            Self::boss_hp_for_player_count(self.player_count)
        } else {
            1
        };
        self.ghosts[ghost_idx].view.stunned_until = 0;

        if ghost_type == GhostType::Boss {
            self.events.push(RuntimeEvent::BossSpawned {
                ghost_id: self.ghosts[ghost_idx].view.id.clone(),
            });
        }
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

        let mut global_candidates: Vec<Vec2> = self
            .world
            .sectors
            .iter()
            .flat_map(|sector| sector.floor_cells.iter().copied())
            .filter(|cell| {
                !self.is_cell_occupied_by_other_ghost(cell.x, cell.y, exclude_ghost_idx)
                    && self.players.iter().all(|player| {
                        player.view.state == PlayerState::Down
                            || manhattan(cell.x, cell.y, player.view.x, player.view.y) >= 3
                    })
            })
            .collect();
        if !global_candidates.is_empty() {
            let idx = self.rng.pick_index(global_candidates.len());
            return Some(global_candidates.swap_remove(idx));
        }

        None
    }
}

#[cfg(test)]
mod tests {
    use super::GameEngine;
    use crate::engine::GameEngineOptions;
    use crate::types::{Difficulty, RuntimeEvent, StartPlayer};

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

    #[test]
    fn boss_hp_is_reduced_for_small_party() {
        assert_eq!(GameEngine::boss_hp_for_player_count(2), 1);
        assert_eq!(GameEngine::boss_hp_for_player_count(5), 2);
        assert_eq!(GameEngine::boss_hp_for_player_count(6), 3);
    }

    #[test]
    fn respawning_as_boss_emits_boss_spawned_event() {
        let mut engine = GameEngine::new(
            make_players(2),
            Difficulty::Normal,
            7_777,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        assert!(!engine.ghosts.is_empty());

        for sector in &mut engine.world.sectors {
            sector.view.captured = false;
        }
        if let Some(first_sector) = engine.world.sectors.first_mut() {
            first_sector.view.captured = true;
        }

        let mut saw_boss_respawn = false;
        for _ in 0..200 {
            engine.events.clear();
            engine.respawn_ghost(0);
            if engine.ghosts[0].view.ghost_type != crate::types::GhostType::Boss {
                continue;
            }
            saw_boss_respawn = true;
            assert_eq!(
                engine.ghosts[0].view.hp,
                GameEngine::boss_hp_for_player_count(2)
            );
            let has_event = engine.events.iter().any(|event| {
                matches!(
                    event,
                    RuntimeEvent::BossSpawned { ghost_id } if ghost_id == &engine.ghosts[0].view.id
                )
            });
            assert!(has_event);
            break;
        }
        assert!(saw_boss_respawn);
    }

    #[test]
    fn spawn_ghost_applies_scaled_boss_hp() {
        let mut duo = GameEngine::new(
            make_players(2),
            Difficulty::Normal,
            7_778,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );
        let mut squad = GameEngine::new(
            make_players(6),
            Difficulty::Normal,
            7_779,
            GameEngineOptions {
                time_limit_ms_override: Some(60_000),
            },
        );

        let mut duo_hp = None;
        for _ in 0..400 {
            duo.ghosts.clear();
            duo.spawn_ghost(duo.started_at_ms, 0.25);
            let Some(ghost) = duo.ghosts.first() else {
                continue;
            };
            if ghost.view.ghost_type == crate::types::GhostType::Boss {
                duo_hp = Some(ghost.view.hp);
                break;
            }
        }

        let mut squad_hp = None;
        for _ in 0..400 {
            squad.ghosts.clear();
            squad.spawn_ghost(squad.started_at_ms, 0.95);
            let Some(ghost) = squad.ghosts.first() else {
                continue;
            };
            if ghost.view.ghost_type == crate::types::GhostType::Boss {
                squad_hp = Some(ghost.view.hp);
                break;
            }
        }

        assert_eq!(duo_hp, Some(GameEngine::boss_hp_for_player_count(2)));
        assert_eq!(squad_hp, Some(GameEngine::boss_hp_for_player_count(6)));
    }
}
