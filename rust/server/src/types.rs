use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
    None,
}

impl Direction {
    pub fn parse_move(value: &str) -> Option<Self> {
        match value {
            "up" => Some(Self::Up),
            "down" => Some(Self::Down),
            "left" => Some(Self::Left),
            "right" => Some(Self::Right),
            "none" => Some(Self::None),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlayerState {
    Normal,
    Power,
    Down,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GhostType {
    Random,
    Chaser,
    Patrol,
    Pincer,
    Invader,
    Boss,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SectorType {
    Normal,
    Narrow,
    Plaza,
    Dark,
    Fast,
    Nest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FruitType {
    Cherry,
    Strawberry,
    Orange,
    Apple,
    Key,
    Grape,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Difficulty {
    Casual,
    Normal,
    Hard,
    Nightmare,
}

impl Difficulty {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "casual" => Some(Self::Casual),
            "normal" => Some(Self::Normal),
            "hard" => Some(Self::Hard),
            "nightmare" => Some(Self::Nightmare),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GameOverReason {
    Victory,
    Timeout,
    AllDown,
    Collapse,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Vec2 {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Debug, Serialize)]
pub struct GateState {
    pub id: String,
    pub a: Vec2,
    pub b: Vec2,
    #[serde(rename = "switchA")]
    pub switch_a: Vec2,
    #[serde(rename = "switchB")]
    pub switch_b: Vec2,
    pub open: bool,
    pub permanent: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct SectorState {
    pub id: usize,
    pub row: i32,
    pub col: i32,
    pub x: i32,
    pub y: i32,
    pub size: i32,
    #[serde(rename = "type")]
    pub sector_type: SectorType,
    pub discovered: bool,
    pub captured: bool,
    #[serde(rename = "dotCount")]
    pub dot_count: i32,
    #[serde(rename = "totalDots")]
    pub total_dots: i32,
}

#[derive(Clone, Debug, Serialize)]
pub struct PowerPelletView {
    pub key: String,
    pub x: i32,
    pub y: i32,
    pub active: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorldInit {
    pub width: i32,
    pub height: i32,
    #[serde(rename = "sectorSize")]
    pub sector_size: i32,
    pub side: i32,
    pub tiles: Vec<String>,
    pub sectors: Vec<SectorState>,
    pub gates: Vec<GateState>,
    pub dots: Vec<(i32, i32)>,
    #[serde(rename = "powerPellets")]
    pub power_pellets: Vec<PowerPelletView>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GameConfig {
    #[serde(rename = "tickRate")]
    pub tick_rate: u32,
    #[serde(rename = "dotsForAwaken")]
    pub dots_for_awaken: i32,
    #[serde(rename = "awakenMaxStock")]
    pub awaken_max_stock: i32,
    #[serde(rename = "powerDurationMs")]
    pub power_duration_ms: u64,
    #[serde(rename = "awakenDurationMs")]
    pub awaken_duration_ms: u64,
    #[serde(rename = "rescueTimeoutMs")]
    pub rescue_timeout_ms: u64,
    #[serde(rename = "timeLimitMs")]
    pub time_limit_ms: u64,
    pub difficulty: Difficulty,
}

#[derive(Clone, Debug, Serialize)]
pub struct PlayerView {
    pub id: String,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub dir: Direction,
    pub state: PlayerState,
    pub stocks: i32,
    pub gauge: i32,
    #[serde(rename = "gaugeMax")]
    pub gauge_max: i32,
    pub score: i32,
    pub connected: bool,
    pub ai: bool,
    #[serde(rename = "speedBuffUntil")]
    pub speed_buff_until: u64,
    #[serde(rename = "powerUntil")]
    pub power_until: u64,
    #[serde(rename = "downSince")]
    pub down_since: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GhostView {
    pub id: String,
    pub x: i32,
    pub y: i32,
    pub dir: Direction,
    #[serde(rename = "type")]
    pub ghost_type: GhostType,
    pub hp: i32,
    #[serde(rename = "stunnedUntil")]
    pub stunned_until: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct FruitView {
    pub id: String,
    #[serde(rename = "type")]
    pub fruit_type: FruitType,
    pub x: i32,
    pub y: i32,
    #[serde(rename = "spawnedAt")]
    pub spawned_at: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct TimelineEvent {
    #[serde(rename = "atMs")]
    pub at_ms: u64,
    pub label: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeEvent {
    DotEaten {
        x: i32,
        y: i32,
        by: String,
    },
    DotRespawned {
        x: i32,
        y: i32,
    },
    PelletTaken {
        key: String,
    },
    PelletRespawned {
        key: String,
    },
    PlayerDown {
        #[serde(rename = "playerId")]
        player_id: String,
    },
    PlayerRevived {
        #[serde(rename = "playerId")]
        player_id: String,
        by: String,
        auto: bool,
    },
    SectorCaptured {
        #[serde(rename = "sectorId")]
        sector_id: usize,
    },
    SectorLost {
        #[serde(rename = "sectorId")]
        sector_id: usize,
    },
    FruitSpawned {
        fruit: FruitView,
    },
    FruitTaken {
        #[serde(rename = "fruitId")]
        fruit_id: String,
        by: String,
        #[serde(rename = "fruitType")]
        fruit_type: FruitType,
    },
    BossSpawned {
        #[serde(rename = "ghostId")]
        ghost_id: String,
    },
    BossHit {
        #[serde(rename = "ghostId")]
        ghost_id: String,
        hp: i32,
        by: String,
    },
    Toast {
        message: String,
    },
}

#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub tick: u64,
    #[serde(rename = "nowMs")]
    pub now_ms: u64,
    #[serde(rename = "timeLeftMs")]
    pub time_left_ms: u64,
    #[serde(rename = "captureRatio")]
    pub capture_ratio: f32,
    pub players: Vec<PlayerView>,
    pub ghosts: Vec<GhostView>,
    pub fruits: Vec<FruitView>,
    pub sectors: Vec<SectorState>,
    pub gates: Vec<GateState>,
    pub events: Vec<RuntimeEvent>,
    pub timeline: Vec<TimelineEvent>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScoreEntry {
    #[serde(rename = "playerId")]
    pub player_id: String,
    pub name: String,
    pub score: i32,
    pub dots: i32,
    pub ghosts: i32,
    pub rescues: i32,
    pub captures: i32,
}

#[derive(Clone, Debug, Serialize)]
pub struct AwardWinner {
    #[serde(rename = "playerId")]
    pub player_id: String,
    pub name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AwardId {
    RescueKing,
    ExplorerKing,
    DefenseKing,
    GhostHunter,
}

#[derive(Clone, Debug, Serialize)]
pub struct AwardEntry {
    pub id: AwardId,
    pub title: String,
    #[serde(rename = "metricLabel")]
    pub metric_label: String,
    pub value: i32,
    pub winners: Vec<AwardWinner>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GameSummary {
    pub reason: GameOverReason,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
    #[serde(rename = "captureRatio")]
    pub capture_ratio: f32,
    pub timeline: Vec<TimelineEvent>,
    pub ranking: Vec<ScoreEntry>,
    pub awards: Vec<AwardEntry>,
}

#[derive(Clone, Debug)]
pub struct StartPlayer {
    pub id: String,
    pub name: String,
    pub reconnect_token: String,
    pub connected: bool,
}
