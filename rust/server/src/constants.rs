use crate::types::Difficulty;

pub const TICK_RATE: u32 = 20;
pub const TICK_MS: u64 = 1000 / TICK_RATE as u64;

pub const SECTOR_SIZE: i32 = 17;
pub const DOTS_FOR_AWAKEN: i32 = 50;
pub const MAX_AWAKEN_STOCK: i32 = 3;
pub const POWER_DURATION_MS: u64 = 8_000;
pub const AWAKEN_DURATION_MS: u64 = 6_000;
pub const RESCUE_TIMEOUT_MS: u64 = 30_000;
pub const POWER_PELLET_RESPAWN_MS: u64 = 90_000;

pub const PLAYER_BASE_SPEED: f32 = 6.0;
pub const PLAYER_CAPTURED_SPEED_MULTIPLIER: f32 = 1.2;
pub const GHOST_BASE_SPEED: f32 = 4.6;

pub fn get_map_side_by_player_count(player_count: usize) -> i32 {
    if player_count <= 5 {
        return 2;
    }
    if player_count <= 15 {
        return 3;
    }
    if player_count <= 30 {
        return 4;
    }
    if player_count <= 60 {
        return 5;
    }
    6
}

pub fn get_initial_ghost_count(player_count: usize) -> usize {
    if player_count <= 1 {
        return 4;
    }
    if player_count <= 5 {
        return 8;
    }
    if player_count <= 15 {
        return 20;
    }
    if player_count <= 30 {
        return 40;
    }
    if player_count <= 60 {
        return 65;
    }
    100
}

pub fn get_time_limit_ms(player_count: usize) -> u64 {
    if player_count <= 5 {
        return 15 * 60 * 1000;
    }
    if player_count <= 15 {
        return 18 * 60 * 1000;
    }
    if player_count <= 30 {
        return 22 * 60 * 1000;
    }
    if player_count <= 60 {
        return 26 * 60 * 1000;
    }
    30 * 60 * 1000
}

pub fn get_difficulty_multiplier(difficulty: Difficulty) -> (f32, f32) {
    match difficulty {
        Difficulty::Casual => (0.8, 0.6),
        Difficulty::Normal => (1.0, 1.0),
        Difficulty::Hard => (1.2, 1.4),
        Difficulty::Nightmare => (1.5, 2.0),
    }
}

pub fn get_capture_pressure(capture_ratio: f32) -> (u64, f32) {
    if capture_ratio <= 0.3 {
        return (120_000, 1.0);
    }
    if capture_ratio <= 0.5 {
        return (90_000, 1.3);
    }
    if capture_ratio <= 0.7 {
        return (60_000, 1.8);
    }
    if capture_ratio <= 0.85 {
        return (40_000, 2.5);
    }
    if capture_ratio <= 0.95 {
        return (25_000, 3.5);
    }
    (15_000, 5.0)
}
