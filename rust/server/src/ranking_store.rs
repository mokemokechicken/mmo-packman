use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::types::{
    GameOverReason, GameSummary, PersistentRankingEntry, RankingResponse, ScoreEntry,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredRankingEntry {
    name: String,
    matches: u64,
    wins: u64,
    #[serde(rename = "totalCaptureRatio", alias = "total_capture_ratio")]
    total_capture_ratio: f64,
    #[serde(rename = "totalRescues", alias = "total_rescues")]
    total_rescues: f64,
    #[serde(rename = "bestScore", alias = "best_score")]
    best_score: i32,
    #[serde(rename = "updatedAtMs", alias = "updated_at_ms")]
    updated_at_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RankingStoreFile {
    version: u8,
    players: HashMap<String, StoredRankingEntry>,
}

#[derive(Clone, Debug, Deserialize)]
struct RankingStoreFileRaw {
    version: u8,
    players: HashMap<String, serde_json::Value>,
}

pub struct RankingStore {
    file_path: PathBuf,
    players: HashMap<String, StoredRankingEntry>,
}

impl RankingStore {
    pub fn new(file_path: PathBuf) -> Self {
        let players = load_players(&file_path);
        Self { file_path, players }
    }

    pub fn record_match(&mut self, summary: &GameSummary) {
        let won = summary.reason == GameOverReason::Victory;
        let now_ms = now_ms();

        for entry in &summary.ranking {
            if is_ai_player(entry) {
                continue;
            }

            let key = ranking_key(&entry.name);
            if key.is_empty() {
                continue;
            }
            let current = self
                .players
                .entry(key)
                .or_insert_with(|| StoredRankingEntry {
                    name: entry.name.trim().to_string(),
                    matches: 0,
                    wins: 0,
                    total_capture_ratio: 0.0,
                    total_rescues: 0.0,
                    best_score: 0,
                    updated_at_ms: now_ms,
                });

            current.name = entry.name.trim().to_string();
            current.matches += 1;
            if won {
                current.wins += 1;
            }
            current.total_capture_ratio += summary.capture_ratio as f64;
            current.total_rescues += entry.rescues as f64;
            current.best_score = current.best_score.max(entry.score);
            current.updated_at_ms = now_ms;
        }

        self.save();
    }

    pub fn build_response(&self, requested_limit: Option<usize>) -> RankingResponse {
        RankingResponse {
            generated_at_iso: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            entries: self.get_top(requested_limit),
        }
    }

    fn get_top(&self, requested_limit: Option<usize>) -> Vec<PersistentRankingEntry> {
        let normalized_limit = requested_limit.unwrap_or(10).clamp(1, 100);
        let mut entries: Vec<PersistentRankingEntry> = self
            .players
            .values()
            .map(|entry| {
                let matches = entry.matches.max(1) as f64;
                PersistentRankingEntry {
                    name: entry.name.clone(),
                    matches: entry.matches,
                    wins: entry.wins.min(entry.matches),
                    win_rate: entry.wins as f64 / matches,
                    avg_capture_ratio: entry.total_capture_ratio / matches,
                    avg_rescues: entry.total_rescues / matches,
                    best_score: entry.best_score,
                    updated_at_ms: entry.updated_at_ms,
                }
            })
            .collect();

        entries.sort_by(|a, b| {
            cmp_desc_f64(a.win_rate, b.win_rate)
                .then_with(|| cmp_desc_f64(a.avg_capture_ratio, b.avg_capture_ratio))
                .then_with(|| cmp_desc_f64(a.avg_rescues, b.avg_rescues))
                .then_with(|| b.best_score.cmp(&a.best_score))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        entries.truncate(normalized_limit);
        entries
    }

    fn save(&self) {
        if let Some(parent) = self.file_path.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                eprintln!(
                    "[ranking-store] failed to create parent dir {}: {error}",
                    parent.display()
                );
                return;
            }
        }

        let payload = RankingStoreFile {
            version: 1,
            players: self.players.clone(),
        };
        match serde_json::to_string_pretty(&payload) {
            Ok(text) => {
                if let Err(error) = fs::write(&self.file_path, text) {
                    eprintln!(
                        "[ranking-store] failed to write {}: {error}",
                        self.file_path.display()
                    );
                }
            }
            Err(error) => {
                eprintln!(
                    "[ranking-store] failed to serialize payload for {}: {error}",
                    self.file_path.display()
                );
            }
        }
    }
}

fn cmp_desc_f64(a: f64, b: f64) -> Ordering {
    b.partial_cmp(&a).unwrap_or(Ordering::Equal)
}

fn load_players(path: &Path) -> HashMap<String, StoredRankingEntry> {
    let text = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("[ranking-store] failed to read {}: {error}", path.display());
            }
            return HashMap::new();
        }
    };
    let parsed: RankingStoreFileRaw = match serde_json::from_str::<RankingStoreFileRaw>(&text) {
        Ok(value) if value.version == 1 => value,
        Ok(value) => {
            eprintln!(
                "[ranking-store] unsupported version {} at {}",
                value.version,
                path.display()
            );
            return HashMap::new();
        }
        Err(error) => {
            eprintln!(
                "[ranking-store] failed to parse {}: {error}",
                path.display()
            );
            return HashMap::new();
        }
    };

    let mut sanitized = HashMap::<String, StoredRankingEntry>::new();
    for (player_key, raw_value) in parsed.players {
        let value: StoredRankingEntry = match serde_json::from_value(raw_value) {
            Ok(entry) => entry,
            Err(error) => {
                eprintln!(
                    "[ranking-store] failed to parse player entry '{}' in {}: {error}",
                    player_key,
                    path.display()
                );
                continue;
            }
        };
        let Some(normalized) = sanitize_stored_entry(value) else {
            continue;
        };
        let key = ranking_key(&normalized.name);
        if key.is_empty() {
            continue;
        }

        match sanitized.get_mut(&key) {
            Some(current) => {
                current.name = normalized.name;
                current.matches += normalized.matches;
                current.wins += normalized.wins.min(normalized.matches);
                current.total_capture_ratio += normalized.total_capture_ratio;
                current.total_rescues += normalized.total_rescues;
                current.best_score = current.best_score.max(normalized.best_score);
                current.updated_at_ms = current.updated_at_ms.max(normalized.updated_at_ms);
            }
            None => {
                sanitized.insert(key, normalized);
            }
        }
    }

    sanitized
}

fn sanitize_stored_entry(value: StoredRankingEntry) -> Option<StoredRankingEntry> {
    let normalized_name = value.name.trim().to_string();
    if normalized_name.is_empty() {
        return None;
    }
    if !value.total_capture_ratio.is_finite() || value.total_capture_ratio < 0.0 {
        return None;
    }
    if !value.total_rescues.is_finite() || value.total_rescues < 0.0 {
        return None;
    }
    let normalized_matches = value.matches;
    let normalized_wins = value.wins.min(normalized_matches);
    Some(StoredRankingEntry {
        name: normalized_name,
        matches: normalized_matches,
        wins: normalized_wins,
        total_capture_ratio: value.total_capture_ratio,
        total_rescues: value.total_rescues,
        best_score: value.best_score.max(0),
        updated_at_ms: value.updated_at_ms,
    })
}

fn ranking_key(name: &str) -> String {
    name.trim().to_lowercase()
}

fn is_ai_player(entry: &ScoreEntry) -> bool {
    entry.player_id.starts_with("ai_")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AwardEntry, AwardId, AwardWinner, GameSummary, ScoreEntry, TimelineEvent};

    fn make_summary(
        reason: GameOverReason,
        capture_ratio: f32,
        rows: Vec<(&str, &str, i32, i32)>,
    ) -> GameSummary {
        GameSummary {
            reason,
            duration_ms: 60_000,
            capture_ratio,
            timeline: vec![TimelineEvent {
                at_ms: 1,
                label: "test".to_string(),
            }],
            ranking: rows
                .into_iter()
                .map(|(id, name, score, rescues)| ScoreEntry {
                    player_id: id.to_string(),
                    name: name.to_string(),
                    score,
                    dots: 0,
                    ghosts: 0,
                    rescues,
                    captures: 0,
                })
                .collect(),
            awards: vec![AwardEntry {
                id: AwardId::RescueKing,
                title: "x".to_string(),
                metric_label: "x".to_string(),
                value: 1,
                winners: vec![AwardWinner {
                    player_id: "p1".to_string(),
                    name: "P1".to_string(),
                }],
            }],
        }
    }

    fn temp_file(name: &str) -> PathBuf {
        let unique = format!(
            "{}-{}-{}",
            name,
            std::process::id(),
            now_ms().saturating_add(rand::random::<u32>() as u64)
        );
        std::env::temp_dir().join(unique).join("ranking.json")
    }

    #[test]
    fn record_match_aggregates_humans_only() {
        let path = temp_file("ranking-store-record");
        let mut store = RankingStore::new(path.clone());
        store.record_match(&make_summary(
            GameOverReason::Victory,
            0.8,
            vec![("p1", "Alice", 100, 3), ("ai_1", "AI-01", 200, 0)],
        ));
        store.record_match(&make_summary(
            GameOverReason::Timeout,
            0.4,
            vec![("p1", "Alice", 50, 1), ("p2", "Bob", 80, 2)],
        ));

        let response = store.build_response(Some(10));
        assert_eq!(response.entries.len(), 2);
        let alice = response
            .entries
            .iter()
            .find(|entry| entry.name == "Alice")
            .expect("alice exists");
        assert_eq!(alice.matches, 2);
        assert_eq!(alice.wins, 1);
        assert_eq!(alice.best_score, 100);
        assert!(response
            .entries
            .iter()
            .all(|entry| !entry.name.starts_with("AI-")));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn record_match_keeps_human_name_even_if_prefixed_with_ai() {
        let path = temp_file("ranking-store-human-ai-prefix");
        let mut store = RankingStore::new(path.clone());
        store.record_match(&make_summary(
            GameOverReason::Victory,
            0.9,
            vec![("p1", "AI-Human", 10, 1), ("ai_1", "AI-01", 5, 0)],
        ));

        let response = store.build_response(Some(10));
        assert_eq!(response.entries.len(), 1);
        assert_eq!(response.entries[0].name, "AI-Human");
        assert_eq!(response.entries[0].matches, 1);
        assert_eq!(response.entries[0].wins, 1);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn load_merges_case_insensitive_names() {
        let path = temp_file("ranking-store-load");
        let parent = path.parent().expect("parent exists").to_path_buf();
        fs::create_dir_all(&parent).expect("create dir");
        let raw = r#"{
  "version": 1,
  "players": {
    "ALICE": {
      "name": "Alice",
      "matches": 2,
      "wins": 1,
      "totalCaptureRatio": 1.0,
      "totalRescues": 3.0,
      "bestScore": 120,
      "updatedAtMs": 10
    },
    "alice_legacy": {
      "name": " alice ",
      "matches": 1,
      "wins": 1,
      "totalCaptureRatio": 0.7,
      "totalRescues": 1.0,
      "bestScore": 80,
      "updatedAtMs": 20
    }
  }
}"#;
        fs::write(&path, raw).expect("write file");

        let store = RankingStore::new(path.clone());
        let response = store.build_response(Some(10));
        assert_eq!(response.entries.len(), 1);
        let entry = response.entries.first().expect("entry exists");
        assert_eq!(entry.name.to_lowercase(), "alice");
        assert_eq!(entry.matches, 3);
        assert_eq!(entry.wins, 2);

        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn load_keeps_valid_entries_when_invalid_entries_exist() {
        let path = temp_file("ranking-store-partial-load");
        let parent = path.parent().expect("parent exists").to_path_buf();
        fs::create_dir_all(&parent).expect("create dir");
        let raw = r#"{
  "version": 1,
  "players": {
    "valid": {
      "name": "Alice",
      "matches": 2,
      "wins": 1,
      "totalCaptureRatio": 1.0,
      "totalRescues": 3.0,
      "bestScore": 120,
      "updatedAtMs": 10
    },
    "invalid": {
      "name": "Broken",
      "matches": -1
    }
  }
}"#;
        fs::write(&path, raw).expect("write file");

        let store = RankingStore::new(path.clone());
        let response = store.build_response(Some(10));
        assert_eq!(response.entries.len(), 1);
        assert_eq!(response.entries[0].name, "Alice");
        assert_eq!(response.entries[0].matches, 2);
        assert_eq!(response.entries[0].wins, 1);

        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn build_response_limits_range() {
        let path = temp_file("ranking-store-limit");
        let mut store = RankingStore::new(path.clone());
        for idx in 0..3 {
            store.record_match(&make_summary(
                GameOverReason::Timeout,
                0.3,
                vec![(
                    &format!("p{}", idx + 1),
                    &format!("P{}", idx + 1),
                    idx + 1,
                    0,
                )],
            ));
        }

        assert_eq!(store.build_response(Some(1)).entries.len(), 1);
        assert_eq!(store.build_response(Some(0)).entries.len(), 1);
        assert_eq!(store.build_response(Some(999)).entries.len(), 3);

        let _ = fs::remove_file(path);
    }
}
