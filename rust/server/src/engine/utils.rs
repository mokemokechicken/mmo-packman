use std::time::{SystemTime, UNIX_EPOCH};

use crate::rng::Rng;
use crate::types::{Direction, GhostType};

pub(super) fn now_ms() -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    now as u64
}

pub(super) fn manhattan(ax: i32, ay: i32, bx: i32, by: i32) -> i32 {
    (ax - bx).abs() + (ay - by).abs()
}

pub(super) fn offset(x: i32, y: i32, dir: Direction) -> (i32, i32) {
    match dir {
        Direction::Up => (x, y - 1),
        Direction::Down => (x, y + 1),
        Direction::Left => (x - 1, y),
        Direction::Right => (x + 1, y),
        Direction::None => (x, y),
    }
}

pub(super) fn sector_id_from_coords(
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

pub(super) fn random_direction(rng: &mut Rng) -> Direction {
    match rng.int(0, 3) {
        0 => Direction::Up,
        1 => Direction::Down,
        2 => Direction::Left,
        _ => Direction::Right,
    }
}

pub(super) fn pick_ghost_type(capture_ratio: f32, player_count: usize, rng: &mut Rng) -> GhostType {
    let roll = rng.next_f32();
    let mut ghost_type = if capture_ratio < 0.3 {
        if roll < 0.75 {
            GhostType::Random
        } else {
            GhostType::Chaser
        }
    } else if capture_ratio < 0.6 {
        if roll < 0.3 {
            GhostType::Random
        } else if roll < 0.55 {
            GhostType::Chaser
        } else if roll < 0.8 {
            GhostType::Patrol
        } else {
            GhostType::Pincer
        }
    } else if capture_ratio < 0.9 {
        if roll < 0.2 {
            GhostType::Random
        } else if roll < 0.4 {
            GhostType::Chaser
        } else if roll < 0.6 {
            GhostType::Patrol
        } else if roll < 0.8 {
            GhostType::Pincer
        } else {
            GhostType::Invader
        }
    } else if roll < 0.1 {
        GhostType::Random
    } else if roll < 0.25 {
        GhostType::Chaser
    } else if roll < 0.5 {
        GhostType::Pincer
    } else if roll < 0.8 {
        GhostType::Invader
    } else {
        GhostType::Boss
    };

    if player_count <= 5 && capture_ratio < 0.9 && ghost_type != GhostType::Boss {
        let bonus_boss_chance = if player_count <= 2 {
            if capture_ratio >= 0.25 {
                0.12
            } else {
                0.02
            }
        } else if capture_ratio >= 0.6 {
            0.24
        } else if capture_ratio >= 0.45 {
            0.14
        } else if capture_ratio >= 0.25 {
            0.07
        } else {
            0.0
        };
        let bonus_roll = ((roll * 9_973.0) + 0.37).fract();
        if bonus_boss_chance > 0.0 && bonus_roll < bonus_boss_chance {
            ghost_type = GhostType::Boss;
        }
    }
    ghost_type
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_party_can_roll_boss_before_ninety_percent_capture() {
        let mut saw_boss = false;
        for seed in 1..=2_000u32 {
            let mut rng = Rng::new(seed);
            if pick_ghost_type(0.45, 5, &mut rng) == GhostType::Boss {
                saw_boss = true;
                break;
            }
        }
        assert!(saw_boss);
    }

    #[test]
    fn duo_can_roll_boss_even_at_low_capture() {
        let mut saw_boss = false;
        for seed in 1..=2_000u32 {
            let mut rng = Rng::new(seed);
            if pick_ghost_type(0.0, 2, &mut rng) == GhostType::Boss {
                saw_boss = true;
                break;
            }
        }
        assert!(saw_boss);
    }

    #[test]
    fn large_party_never_rolls_boss_before_ninety_percent_capture() {
        for seed in 1..=2_000u32 {
            let mut rng = Rng::new(seed);
            assert_ne!(pick_ghost_type(0.85, 80, &mut rng), GhostType::Boss);
        }
    }

    #[test]
    fn small_party_does_not_get_extra_boss_bonus_after_ninety_percent_capture() {
        for seed in 1..=2_000u32 {
            let mut small_rng = Rng::new(seed);
            let mut large_rng = Rng::new(seed);
            let small = pick_ghost_type(0.95, 5, &mut small_rng);
            let large = pick_ghost_type(0.95, 80, &mut large_rng);
            assert_eq!(small as u8, large as u8);
        }
    }
}
