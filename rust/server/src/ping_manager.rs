use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::types::{PingType, PingView};

static NEXT_PING_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug)]
pub struct PingManagerOptions {
    pub ttl_ms: u64,
    pub max_active_pings: usize,
    pub max_per_player: usize,
    pub rate_window_ms: u64,
    pub max_per_window: usize,
}

impl Default for PingManagerOptions {
    fn default() -> Self {
        Self {
            ttl_ms: 8_000,
            max_active_pings: 24,
            max_per_player: 4,
            rate_window_ms: 4_000,
            max_per_window: 3,
        }
    }
}

#[derive(Clone, Debug)]
pub struct PlacePingInput {
    pub owner_id: String,
    pub owner_name: String,
    pub x: i32,
    pub y: i32,
    pub kind: PingType,
    pub now_ms: u64,
    pub spectator: bool,
}

#[derive(Clone, Debug)]
pub struct PlacePingResult {
    pub ok: bool,
    pub reason: Option<String>,
}

impl PlacePingResult {
    fn ok() -> Self {
        Self {
            ok: true,
            reason: None,
        }
    }

    fn err(reason: &str) -> Self {
        Self {
            ok: false,
            reason: Some(reason.to_string()),
        }
    }
}

pub struct PingManager {
    options: PingManagerOptions,
    pings: Vec<PingView>,
    history_by_owner: HashMap<String, Vec<u64>>,
}

impl PingManager {
    pub fn new(options: PingManagerOptions) -> Self {
        Self {
            options,
            pings: Vec::new(),
            history_by_owner: HashMap::new(),
        }
    }

    pub fn clear(&mut self) {
        self.pings.clear();
        self.history_by_owner.clear();
    }

    pub fn place(&mut self, input: PlacePingInput) -> PlacePingResult {
        self.prune(input.now_ms);

        if input.spectator {
            return PlacePingResult::err("spectator cannot place ping");
        }

        let history = self
            .history_by_owner
            .entry(input.owner_id.clone())
            .or_default();
        history.retain(|at| input.now_ms.saturating_sub(*at) <= self.options.rate_window_ms);
        if history.len() >= self.options.max_per_window {
            return PlacePingResult::err("ping rate limit exceeded");
        }
        history.push(input.now_ms);

        self.trim_owner_pings(&input.owner_id);
        while self.pings.len() >= self.options.max_active_pings {
            self.pings.remove(0);
        }

        self.pings.push(PingView {
            id: format!("ping_{}", NEXT_PING_ID.fetch_add(1, Ordering::Relaxed)),
            owner_id: input.owner_id,
            owner_name: input.owner_name,
            x: input.x,
            y: input.y,
            kind: input.kind,
            created_at_ms: input.now_ms,
            expires_at_ms: input.now_ms + self.options.ttl_ms,
        });
        PlacePingResult::ok()
    }

    pub fn snapshot(&mut self, now_ms: u64) -> Vec<PingView> {
        self.prune(now_ms);
        self.pings.clone()
    }

    fn prune(&mut self, now_ms: u64) {
        self.pings.retain(|ping| ping.expires_at_ms > now_ms);

        for history in self.history_by_owner.values_mut() {
            history.retain(|at| now_ms.saturating_sub(*at) <= self.options.rate_window_ms);
        }
        self.history_by_owner
            .retain(|_, history| !history.is_empty());
    }

    fn trim_owner_pings(&mut self, owner_id: &str) {
        let mut owner_count = self
            .pings
            .iter()
            .filter(|ping| ping.owner_id == owner_id)
            .count();
        if owner_count < self.options.max_per_player {
            return;
        }

        let mut index = 0;
        while index < self.pings.len() && owner_count >= self.options.max_per_player {
            if self.pings[index].owner_id == owner_id {
                self.pings.remove(index);
                owner_count -= 1;
                continue;
            }
            index += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place(
        manager: &mut PingManager,
        owner_id: &str,
        owner_name: &str,
        kind: PingType,
        now_ms: u64,
        spectator: bool,
        pos: (i32, i32),
    ) -> PlacePingResult {
        manager.place(PlacePingInput {
            owner_id: owner_id.to_string(),
            owner_name: owner_name.to_string(),
            x: pos.0,
            y: pos.1,
            kind,
            now_ms,
            spectator,
        })
    }

    #[test]
    fn spectator_is_denied() {
        let mut manager = PingManager::new(PingManagerOptions::default());
        let result = place(
            &mut manager,
            "p1",
            "Spec",
            PingType::Focus,
            100,
            true,
            (1, 1),
        );
        assert!(!result.ok);
        assert!(manager.snapshot(100).is_empty());
    }

    #[test]
    fn ttl_cleanup_works() {
        let mut manager = PingManager::new(PingManagerOptions {
            ttl_ms: 1_000,
            ..PingManagerOptions::default()
        });
        assert!(
            place(
                &mut manager,
                "p1",
                "Alice",
                PingType::Danger,
                0,
                false,
                (2, 3)
            )
            .ok
        );
        assert_eq!(manager.snapshot(999).len(), 1);
        assert_eq!(manager.snapshot(1_000).len(), 0);
    }

    #[test]
    fn rate_limit_works() {
        let mut manager = PingManager::new(PingManagerOptions {
            rate_window_ms: 4_000,
            max_per_window: 3,
            ..PingManagerOptions::default()
        });
        assert!(
            place(
                &mut manager,
                "p1",
                "Alice",
                PingType::Help,
                0,
                false,
                (1, 1)
            )
            .ok
        );
        assert!(
            place(
                &mut manager,
                "p1",
                "Alice",
                PingType::Help,
                100,
                false,
                (1, 1)
            )
            .ok
        );
        assert!(
            place(
                &mut manager,
                "p1",
                "Alice",
                PingType::Help,
                200,
                false,
                (1, 1)
            )
            .ok
        );
        assert!(
            !place(
                &mut manager,
                "p1",
                "Alice",
                PingType::Help,
                300,
                false,
                (1, 1)
            )
            .ok
        );
        assert!(
            place(
                &mut manager,
                "p1",
                "Alice",
                PingType::Help,
                4_500,
                false,
                (1, 1)
            )
            .ok
        );
    }

    #[test]
    fn per_player_cap_removes_oldest_ping() {
        let mut manager = PingManager::new(PingManagerOptions {
            ttl_ms: 20_000,
            max_per_player: 2,
            max_per_window: 10,
            ..PingManagerOptions::default()
        });
        assert!(
            place(
                &mut manager,
                "p1",
                "Alice",
                PingType::Focus,
                0,
                false,
                (1, 1)
            )
            .ok
        );
        assert!(
            place(
                &mut manager,
                "p1",
                "Alice",
                PingType::Focus,
                100,
                false,
                (2, 1)
            )
            .ok
        );
        assert!(
            place(
                &mut manager,
                "p1",
                "Alice",
                PingType::Focus,
                200,
                false,
                (3, 1)
            )
            .ok
        );

        let pings = manager.snapshot(250);
        assert_eq!(pings.len(), 2);
        assert!(!pings.iter().any(|ping| ping.x == 1));
    }

    #[test]
    fn global_cap_removes_oldest_ping() {
        let mut manager = PingManager::new(PingManagerOptions {
            max_active_pings: 3,
            max_per_player: 10,
            max_per_window: 10,
            ttl_ms: 60_000,
            ..PingManagerOptions::default()
        });
        for idx in 0..5u64 {
            assert!(
                place(
                    &mut manager,
                    &format!("p{idx}"),
                    &format!("P{idx}"),
                    PingType::Focus,
                    idx * 100,
                    false,
                    (idx as i32, 0)
                )
                .ok
            );
        }

        let pings = manager.snapshot(1_000);
        assert_eq!(pings.len(), 3);
        let owners: Vec<String> = pings.iter().map(|ping| ping.owner_id.clone()).collect();
        assert_eq!(owners, vec!["p2", "p3", "p4"]);
    }
}
