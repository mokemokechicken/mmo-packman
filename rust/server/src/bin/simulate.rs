use clap::Parser;
use mmo_packman_rust_server::constants::TICK_MS;
use mmo_packman_rust_server::engine::{GameEngine, GameEngineOptions};
use mmo_packman_rust_server::types::{Difficulty, RuntimeEvent, Snapshot, StartPlayer};
use serde::Serialize;

#[derive(Parser, Debug)]
#[command(author, version, about)]
struct Cli {
    #[arg(long)]
    single: bool,
    #[arg(long)]
    ai: Option<i32>,
    #[arg(long)]
    minutes: Option<i32>,
    #[arg(long)]
    difficulty: Option<String>,
    #[arg(long)]
    seed: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
struct Scenario {
    name: String,
    #[serde(rename = "aiPlayers")]
    ai_players: usize,
    minutes: i32,
    difficulty: Difficulty,
    seed: u32,
}

#[derive(Clone, Debug, Serialize)]
struct ScenarioResultLine {
    scenario: String,
    seed: u32,
    #[serde(rename = "aiPlayers")]
    ai_players: usize,
    minutes: i32,
    difficulty: Difficulty,
    reason: mmo_packman_rust_server::types::GameOverReason,
    #[serde(rename = "maxCapture")]
    max_capture: f32,
    #[serde(rename = "minCaptureAfter70")]
    min_capture_after70: f32,
    #[serde(rename = "dotEaten")]
    dot_eaten: i32,
    #[serde(rename = "dotRespawned")]
    dot_respawned: i32,
    downs: i32,
    rescues: i32,
    #[serde(rename = "sectorCaptured")]
    sector_captured: i32,
    #[serde(rename = "sectorLost")]
    sector_lost: i32,
    #[serde(rename = "bossSpawned")]
    boss_spawned: i32,
    #[serde(rename = "bossHits")]
    boss_hits: i32,
    anomalies: Vec<String>,
}

fn main() {
    let cli = Cli::parse();
    let scenarios = resolve_scenarios(&cli);
    let mut has_anomaly = false;

    for scenario in scenarios {
        let result = run_scenario(&scenario);
        if !result.anomalies.is_empty() {
            has_anomaly = true;
        }
        println!(
            "{}",
            serde_json::to_string(&result).expect("scenario result should serialize")
        );
    }

    if has_anomaly {
        std::process::exit(1);
    }
}

fn run_scenario(scenario: &Scenario) -> ScenarioResultLine {
    let mut start_players = Vec::new();
    for idx in 0..scenario.ai_players {
        start_players.push(StartPlayer {
            id: format!("ai_{}", idx + 1),
            name: format!("AI-{:02}", idx + 1),
            reconnect_token: format!("sim_{}_{}", scenario.seed, idx + 1),
            connected: false,
        });
    }

    let mut engine = GameEngine::new(
        start_players,
        scenario.difficulty,
        scenario.seed,
        GameEngineOptions {
            time_limit_ms_override: Some((scenario.minutes as u64) * 60_000),
        },
    );

    let mut max_capture = 0.0f32;
    let mut min_capture_after_70 = 1.0f32;
    let mut crossed_70 = false;
    let mut dot_eaten = 0;
    let mut dot_respawned = 0;
    let mut downs = 0;
    let mut rescues = 0;
    let mut sector_captured = 0;
    let mut sector_lost = 0;
    let mut boss_spawned = 0;
    let mut boss_hits = 0;
    let mut anomalies = Vec::new();
    let mut tick_safety = 0usize;

    while !engine.is_ended() {
        engine.step(TICK_MS);
        let snapshot = engine.build_snapshot(true);
        validate_snapshot(&snapshot, &mut anomalies);
        tick_safety += 1;
        if tick_safety > 20 * 60 * 15 {
            anomalies.push("tick safety limit exceeded".to_string());
            break;
        }

        max_capture = max_capture.max(snapshot.capture_ratio);
        if snapshot.capture_ratio >= 0.7 {
            crossed_70 = true;
        }
        if crossed_70 {
            min_capture_after_70 = min_capture_after_70.min(snapshot.capture_ratio);
        }

        for event in &snapshot.events {
            match event {
                RuntimeEvent::DotEaten { .. } => dot_eaten += 1,
                RuntimeEvent::DotRespawned { .. } => dot_respawned += 1,
                RuntimeEvent::PlayerDown { .. } => downs += 1,
                RuntimeEvent::PlayerRevived { .. } => rescues += 1,
                RuntimeEvent::SectorCaptured { .. } => sector_captured += 1,
                RuntimeEvent::SectorLost { .. } => sector_lost += 1,
                RuntimeEvent::BossSpawned { .. } => boss_spawned += 1,
                RuntimeEvent::BossHit { .. } => boss_hits += 1,
                _ => {}
            }
        }
    }

    let summary = engine.build_summary();
    if crossed_70 && min_capture_after_70 <= 0.2 {
        anomalies.push(format!(
            "capture collapse: reached >=70% but dropped to {:.1}%",
            min_capture_after_70 * 100.0
        ));
    }

    ScenarioResultLine {
        scenario: scenario.name.clone(),
        seed: scenario.seed,
        ai_players: scenario.ai_players,
        minutes: scenario.minutes,
        difficulty: scenario.difficulty,
        reason: summary.reason,
        max_capture: (max_capture * 1000.0).round() / 10.0,
        min_capture_after70: (if crossed_70 {
            min_capture_after_70
        } else {
            1.0
        } * 1000.0)
            .round()
            / 10.0,
        dot_eaten,
        dot_respawned,
        downs,
        rescues,
        sector_captured,
        sector_lost,
        boss_spawned,
        boss_hits,
        anomalies,
    }
}

fn validate_snapshot(snapshot: &Snapshot, anomalies: &mut Vec<String>) {
    if !snapshot.capture_ratio.is_finite()
        || snapshot.capture_ratio < 0.0
        || snapshot.capture_ratio > 1.0
    {
        anomalies.push(format!("invalid capture ratio: {}", snapshot.capture_ratio));
    }

    let total_dots: i32 = snapshot.sectors.iter().map(|s| s.dot_count).sum();
    if total_dots < 0 {
        anomalies.push(format!("negative total dots: {total_dots}"));
    }

    for player in &snapshot.players {
        if player.gauge < 0 || player.gauge > player.gauge_max {
            anomalies.push(format!(
                "player gauge out of range: {} {}/{}",
                player.id, player.gauge, player.gauge_max
            ));
        }
    }

    for ghost in &snapshot.ghosts {
        if ghost.hp <= 0 {
            anomalies.push(format!("ghost hp <= 0 remains: {}", ghost.id));
        }
    }

    if snapshot.sectors.is_empty() {
        anomalies.push("invalid sector configuration".to_string());
    }
}

fn resolve_scenarios(cli: &Cli) -> Vec<Scenario> {
    let seed = normalize_seed(cli.seed.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }));
    let difficulty = cli
        .difficulty
        .as_deref()
        .and_then(Difficulty::from_str)
        .unwrap_or(Difficulty::Normal);

    if cli.single || cli.ai.is_some() || cli.minutes.is_some() {
        return vec![Scenario {
            name: format!("custom-ai{}", clamp_i32(cli.ai.unwrap_or(2), 1, 100)),
            ai_players: clamp_i32(cli.ai.unwrap_or(2), 1, 100) as usize,
            minutes: clamp_i32(cli.minutes.unwrap_or(3), 1, 10),
            difficulty,
            seed,
        }];
    }

    vec![
        Scenario {
            name: "quick-check-ai2".to_string(),
            ai_players: 2,
            minutes: 2,
            difficulty: Difficulty::Normal,
            seed,
        },
        Scenario {
            name: "balance-check-ai5".to_string(),
            ai_players: 5,
            minutes: 5,
            difficulty: Difficulty::Normal,
            seed: normalize_seed(seed as u64 + 1),
        },
    ]
}

fn clamp_i32(value: i32, min: i32, max: i32) -> i32 {
    value.clamp(min, max)
}

fn normalize_seed(seed: u64) -> u32 {
    seed as u32
}
