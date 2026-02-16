pub fn sanitize_name(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "Player".to_string();
    }
    trimmed.chars().take(16).collect()
}

pub fn is_supported_room(raw: Option<&str>) -> bool {
    match raw {
        None => true,
        Some(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            normalized == "main"
        }
    }
}

pub fn normalize_ai_count(value: Option<i64>) -> usize {
    value.unwrap_or(0).clamp(0, 100) as usize
}

pub fn normalize_time_limit_ms(value: Option<i64>) -> Option<u64> {
    value.map(|minutes| minutes.clamp(1, 10) as u64 * 60_000)
}

pub fn player_order_key(player_id: &str) -> u64 {
    player_id
        .rsplit('_')
        .next()
        .and_then(|suffix| suffix.parse::<u64>().ok())
        .unwrap_or(u64::MAX)
}

pub fn parse_ranking_limit(raw: Option<&str>) -> Option<usize> {
    raw.and_then(|value| value.parse::<usize>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_order_key_uses_numeric_suffix() {
        assert!(player_order_key("player_2") < player_order_key("player_10"));
    }

    #[test]
    fn ranking_limit_parsing_is_lenient_for_invalid_values() {
        assert_eq!(parse_ranking_limit(Some("8")), Some(8));
        assert_eq!(parse_ranking_limit(Some("0")), Some(0));
        assert_eq!(parse_ranking_limit(Some("abc")), None);
        assert_eq!(parse_ranking_limit(Some("-1")), None);
        assert_eq!(parse_ranking_limit(None), None);
    }

    #[test]
    fn unsupported_room_is_rejected() {
        assert!(!is_supported_room(Some("")));
        assert!(!is_supported_room(Some("   ")));
        assert!(!is_supported_room(Some("room-a")));
        assert!(is_supported_room(Some("main")));
        assert!(is_supported_room(Some(" MAIN ")));
    }

    #[test]
    fn sanitize_name_applies_trim_empty_and_max_len() {
        assert_eq!(sanitize_name(""), "Player");
        assert_eq!(sanitize_name("   "), "Player");
        assert_eq!(sanitize_name(" Alice "), "Alice");
        assert_eq!(sanitize_name("12345678901234567890"), "1234567890123456");
    }

    #[test]
    fn normalize_ai_count_clamps_range() {
        assert_eq!(normalize_ai_count(None), 0);
        assert_eq!(normalize_ai_count(Some(-10)), 0);
        assert_eq!(normalize_ai_count(Some(3)), 3);
        assert_eq!(normalize_ai_count(Some(999)), 100);
    }

    #[test]
    fn normalize_time_limit_ms_clamps_minutes() {
        assert_eq!(normalize_time_limit_ms(None), None);
        assert_eq!(normalize_time_limit_ms(Some(-10)), Some(60_000));
        assert_eq!(normalize_time_limit_ms(Some(3)), Some(180_000));
        assert_eq!(normalize_time_limit_ms(Some(999)), Some(600_000));
    }
}
