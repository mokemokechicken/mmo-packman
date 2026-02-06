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

pub(super) fn pick_ghost_type(capture_ratio: f32, rng: &mut Rng) -> GhostType {
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
