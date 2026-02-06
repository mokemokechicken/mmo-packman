use clap::Parser;
use mmo_packman_rust_server::constants::TICK_MS;
use mmo_packman_rust_server::engine::{GameEngine, GameEngineOptions};
use mmo_packman_rust_server::types::{
    Difficulty, GameOverReason, RuntimeEvent, Snapshot, StartPlayer,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

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
    #[arg(long)]
    match_id: Option<String>,
    #[arg(long)]
    summary_out: Option<PathBuf>,
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
    reason: GameOverReason,
    #[serde(rename = "durationMs")]
    duration_ms: u64,
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

#[derive(Clone, Debug, Serialize)]
struct AnomalyRecord {
    tick: u64,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
struct ScenarioRunResult {
    #[serde(flatten)]
    result: ScenarioResultLine,
    #[serde(rename = "anomalyRecords")]
    anomaly_records: Vec<AnomalyRecord>,
    finished_tick: u64,
}

#[derive(Clone, Debug, Serialize)]
struct RunSummary {
    #[serde(rename = "matchId")]
    match_id: String,
    #[serde(rename = "startedAtMs")]
    started_at_ms: u64,
    #[serde(rename = "finishedAtMs")]
    finished_at_ms: u64,
    #[serde(rename = "scenarioCount")]
    scenario_count: usize,
    #[serde(rename = "anomalyCount")]
    anomaly_count: usize,
    #[serde(rename = "averageDurationMs")]
    average_duration_ms: u64,
    #[serde(rename = "reasonCounts")]
    reason_counts: BTreeMap<String, usize>,
    scenarios: Vec<ScenarioResultLine>,
}

#[derive(Clone, Debug, Serialize)]
struct StructuredLogLine {
    #[serde(rename = "timestampMs")]
    timestamp_ms: u64,
    level: String,
    event: String,
    #[serde(rename = "matchId")]
    match_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    scenario: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    seed: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tick: Option<u64>,
    details: Value,
}

fn main() {
    let cli = Cli::parse();
    let scenarios = resolve_scenarios(&cli);
    let run_started_at_ms = now_ms();
    let seed_hint = scenarios.first().map(|scenario| scenario.seed).unwrap_or(0);
    let match_id = cli
        .match_id
        .clone()
        .unwrap_or_else(|| default_match_id(seed_hint, run_started_at_ms));
    let mut has_anomaly = false;
    let mut scenario_results = Vec::new();
    let mut reason_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut total_duration_ms = 0u64;
    let mut total_anomalies = 0usize;

    for scenario in scenarios {
        emit_log(
            "info",
            "scenario_started",
            &match_id,
            Some(&scenario.name),
            Some(scenario.seed),
            None,
            json!({
                "aiPlayers": scenario.ai_players,
                "minutes": scenario.minutes,
                "difficulty": scenario.difficulty,
            }),
        );
        let scenario_run = run_scenario(&scenario);

        for anomaly in &scenario_run.anomaly_records {
            emit_log(
                "warn",
                "anomaly_detected",
                &match_id,
                Some(&scenario.name),
                Some(scenario.seed),
                Some(anomaly.tick),
                json!({
                    "message": anomaly.message,
                }),
            );
        }

        if !scenario_run.result.anomalies.is_empty() {
            has_anomaly = true;
        }
        total_anomalies += scenario_run.anomaly_records.len();
        total_duration_ms += scenario_run.result.duration_ms;
        *reason_counts
            .entry(game_over_reason_key(scenario_run.result.reason))
            .or_insert(0) += 1;

        emit_log(
            "info",
            "scenario_finished",
            &match_id,
            Some(&scenario.name),
            Some(scenario.seed),
            Some(scenario_run.finished_tick),
            json!({
                "reason": scenario_run.result.reason,
                "durationMs": scenario_run.result.duration_ms,
                "maxCapture": scenario_run.result.max_capture,
                "anomalyCount": scenario_run.anomaly_records.len(),
            }),
        );

        println!(
            "{}",
            serde_json::to_string(&scenario_run.result).expect("scenario result should serialize")
        );
        scenario_results.push(scenario_run.result);
    }

    let run_finished_at_ms = now_ms();
    let summary = build_run_summary(
        match_id.clone(),
        run_started_at_ms,
        run_finished_at_ms,
        scenario_results.clone(),
        reason_counts,
        total_anomalies,
        total_duration_ms,
    );

    let mut summary_out_written: Option<String> = None;
    if let Some(path) = cli.summary_out.as_ref() {
        if let Err(error) = write_summary(path, &summary) {
            emit_log(
                "error",
                "summary_write_failed",
                &match_id,
                None,
                None,
                None,
                json!({
                    "path": path.to_string_lossy(),
                    "error": error.to_string(),
                }),
            );
            std::process::exit(2);
        }
        summary_out_written = Some(path.to_string_lossy().to_string());
    }

    emit_log(
        "info",
        "run_finished",
        &match_id,
        None,
        None,
        None,
        json!({
            "scenarioCount": summary.scenario_count,
            "anomalyCount": summary.anomaly_count,
            "averageDurationMs": summary.average_duration_ms,
            "reasonCounts": summary.reason_counts,
            "summaryOut": summary_out_written,
        }),
    );

    if has_anomaly {
        std::process::exit(1);
    }
}

fn run_scenario(scenario: &Scenario) -> ScenarioRunResult {
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
    let mut anomaly_records = Vec::new();
    let mut anomaly_seen = HashSet::new();
    let mut tick_safety = 0usize;
    let mut last_tick = 0u64;

    while !engine.is_ended() {
        engine.step(TICK_MS);
        let snapshot = engine.build_snapshot(true);
        last_tick = snapshot.tick;
        for message in collect_snapshot_anomalies(&snapshot) {
            push_anomaly(
                &mut anomalies,
                &mut anomaly_records,
                &mut anomaly_seen,
                snapshot.tick,
                message,
            );
        }
        tick_safety += 1;
        if tick_safety > 20 * 60 * 15 {
            push_anomaly(
                &mut anomalies,
                &mut anomaly_records,
                &mut anomaly_seen,
                snapshot.tick,
                "tick safety limit exceeded".to_string(),
            );
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
        push_anomaly(
            &mut anomalies,
            &mut anomaly_records,
            &mut anomaly_seen,
            last_tick,
            format!(
                "capture collapse: reached >=70% but dropped to {:.1}%",
                min_capture_after_70 * 100.0
            ),
        );
    }

    ScenarioRunResult {
        result: ScenarioResultLine {
            scenario: scenario.name.clone(),
            seed: scenario.seed,
            ai_players: scenario.ai_players,
            minutes: scenario.minutes,
            difficulty: scenario.difficulty,
            reason: summary.reason,
            duration_ms: summary.duration_ms,
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
        },
        anomaly_records,
        finished_tick: last_tick,
    }
}

fn collect_snapshot_anomalies(snapshot: &Snapshot) -> Vec<String> {
    let mut anomalies = Vec::new();
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
    anomalies
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
        .and_then(Difficulty::parse)
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

fn push_anomaly(
    anomalies: &mut Vec<String>,
    anomaly_records: &mut Vec<AnomalyRecord>,
    anomaly_seen: &mut HashSet<String>,
    tick: u64,
    message: String,
) {
    anomaly_records.push(AnomalyRecord {
        tick,
        message: message.clone(),
    });
    if anomaly_seen.insert(message.clone()) {
        anomalies.push(message);
    }
}

fn default_match_id(seed: u32, timestamp_ms: u64) -> String {
    format!("sim-{seed}-{timestamp_ms}")
}

fn build_run_summary(
    match_id: String,
    started_at_ms: u64,
    finished_at_ms: u64,
    scenarios: Vec<ScenarioResultLine>,
    reason_counts: BTreeMap<String, usize>,
    anomaly_count: usize,
    total_duration_ms: u64,
) -> RunSummary {
    let scenario_count = scenarios.len();
    let average_duration_ms = if scenario_count == 0 {
        0
    } else {
        total_duration_ms / scenario_count as u64
    };
    RunSummary {
        match_id,
        started_at_ms,
        finished_at_ms,
        scenario_count,
        anomaly_count,
        average_duration_ms,
        reason_counts,
        scenarios,
    }
}

fn emit_log(
    level: &str,
    event: &str,
    match_id: &str,
    scenario: Option<&str>,
    seed: Option<u32>,
    tick: Option<u64>,
    details: Value,
) {
    let log_line = StructuredLogLine {
        timestamp_ms: now_ms(),
        level: level.to_string(),
        event: event.to_string(),
        match_id: match_id.to_string(),
        scenario: scenario.map(|value| value.to_string()),
        seed,
        tick,
        details,
    };
    eprintln!(
        "{}",
        serde_json::to_string(&log_line).expect("structured log should serialize")
    );
}

fn game_over_reason_key(reason: GameOverReason) -> String {
    match reason {
        GameOverReason::Victory => "victory",
        GameOverReason::Timeout => "timeout",
        GameOverReason::AllDown => "all_down",
        GameOverReason::Collapse => "collapse",
    }
    .to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn write_summary(path: &Path, summary: &RunSummary) -> io::Result<()> {
    let summary_text = serde_json::to_string_pretty(summary).expect("run summary should serialize");
    std::fs::write(path, summary_text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_scenario_result(reason: GameOverReason, duration_ms: u64) -> ScenarioResultLine {
        ScenarioResultLine {
            scenario: "test".to_string(),
            seed: 42,
            ai_players: 3,
            minutes: 1,
            difficulty: Difficulty::Normal,
            reason,
            duration_ms,
            max_capture: 0.0,
            min_capture_after70: 100.0,
            dot_eaten: 0,
            dot_respawned: 0,
            downs: 0,
            rescues: 0,
            sector_captured: 0,
            sector_lost: 0,
            boss_spawned: 0,
            boss_hits: 0,
            anomalies: Vec::new(),
        }
    }

    #[test]
    fn default_match_id_contains_seed_and_timestamp() {
        assert_eq!(default_match_id(42, 123456789), "sim-42-123456789");
    }

    #[test]
    fn build_run_summary_calculates_average_duration() {
        let summary = build_run_summary(
            "sim-42-1".to_string(),
            1,
            2,
            vec![
                make_scenario_result(GameOverReason::Timeout, 60_000),
                make_scenario_result(GameOverReason::Victory, 90_000),
            ],
            BTreeMap::from([
                ("timeout".to_string(), 1usize),
                ("victory".to_string(), 1usize),
            ]),
            1,
            150_000,
        );
        assert_eq!(summary.average_duration_ms, 75_000);
        assert_eq!(summary.scenario_count, 2);
    }

    #[test]
    fn write_summary_returns_error_when_parent_does_not_exist() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let target = std::env::temp_dir()
            .join(format!("mmo-packman-missing-{now}"))
            .join("summary.json");
        let summary = build_run_summary(
            "sim-1-1".to_string(),
            1,
            2,
            vec![make_scenario_result(GameOverReason::Timeout, 60_000)],
            BTreeMap::from([("timeout".to_string(), 1usize)]),
            0,
            60_000,
        );
        let result = write_summary(&target, &summary);
        assert!(result.is_err());
    }

    #[test]
    fn push_anomaly_keeps_records_and_deduplicates_summary_messages() {
        let mut anomalies = Vec::new();
        let mut records = Vec::new();
        let mut seen = HashSet::new();
        push_anomaly(
            &mut anomalies,
            &mut records,
            &mut seen,
            10,
            "same anomaly".to_string(),
        );
        push_anomaly(
            &mut anomalies,
            &mut records,
            &mut seen,
            11,
            "same anomaly".to_string(),
        );

        assert_eq!(anomalies.len(), 1);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].tick, 10);
        assert_eq!(records[1].tick, 11);
    }
}
