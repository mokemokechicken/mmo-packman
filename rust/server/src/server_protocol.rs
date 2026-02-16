use serde_json::Value;

use crate::types::{Difficulty, Direction, PingType};

#[derive(Debug)]
pub enum ParsedClientMessage {
    Hello {
        name: String,
        reconnect_token: Option<String>,
        spectator: bool,
        room_id: Option<String>,
    },
    LobbyStart {
        difficulty: Option<Difficulty>,
        ai_player_count: Option<i64>,
        time_limit_minutes: Option<i64>,
    },
    Input {
        dir: Option<Direction>,
        awaken: Option<bool>,
    },
    PlacePing {
        kind: PingType,
    },
    Ping {
        t: f64,
    },
}

pub fn parse_client_message(raw: &str) -> Option<ParsedClientMessage> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object()?;
    let message_type = object.get("type")?.as_str()?;

    match message_type {
        "hello" => {
            let name = object.get("name")?.as_str()?.to_string();
            let reconnect_token = match object.get("reconnectToken") {
                None => None,
                Some(value) => Some(value.as_str()?.to_string()),
            };
            let spectator = match object.get("spectator") {
                None => false,
                Some(value) => value.as_bool()?,
            };
            let room_id = match object.get("roomId") {
                None => None,
                Some(value) => Some(value.as_str()?.to_string()),
            };
            Some(ParsedClientMessage::Hello {
                name,
                reconnect_token,
                spectator,
                room_id,
            })
        }
        "lobby_start" => {
            let difficulty = match object.get("difficulty") {
                None => None,
                Some(value) => Difficulty::parse(value.as_str()?),
            };
            if object.get("difficulty").is_some() && difficulty.is_none() {
                return None;
            }
            let ai_player_count = parse_optional_i64(object.get("aiPlayerCount"))?;
            let time_limit_minutes = parse_optional_i64(object.get("timeLimitMinutes"))?;
            Some(ParsedClientMessage::LobbyStart {
                difficulty,
                ai_player_count,
                time_limit_minutes,
            })
        }
        "input" => {
            let dir = match object.get("dir") {
                None => None,
                Some(value) => Direction::parse_move(value.as_str()?),
            };
            if object.get("dir").is_some() && dir.is_none() {
                return None;
            }
            let awaken = match object.get("awaken") {
                None => None,
                Some(value) => Some(value.as_bool()?),
            };
            Some(ParsedClientMessage::Input { dir, awaken })
        }
        "place_ping" => {
            let kind = PingType::parse(object.get("kind")?.as_str()?)?;
            Some(ParsedClientMessage::PlacePing { kind })
        }
        "ping" => {
            let t = object.get("t")?.as_f64()?;
            if !t.is_finite() {
                return None;
            }
            Some(ParsedClientMessage::Ping { t })
        }
        _ => None,
    }
}

fn parse_optional_i64(value: Option<&Value>) -> Option<Option<i64>> {
    const MAX_SAFE_INTEGER_F64: f64 = 9_007_199_254_740_991.0;

    let Some(value) = value else {
        return Some(None);
    };
    if let Some(number) = value.as_i64() {
        return Some(Some(number));
    }
    if let Some(number) = value.as_u64() {
        return i64::try_from(number).ok().map(Some);
    }
    if let Some(number) = value.as_f64() {
        if number.is_finite() {
            let floored = number.floor();
            if floored.abs() > MAX_SAFE_INTEGER_F64 {
                return None;
            }
            if floored < i64::MIN as f64 || floored > i64::MAX as f64 {
                return None;
            }
            return Some(Some(floored as i64));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_hello_message() {
        let parsed = parse_client_message(r#"{"type":"hello","name":"A","spectator":true}"#)
            .expect("hello message should parse");
        match parsed {
            ParsedClientMessage::Hello {
                name,
                reconnect_token,
                spectator,
                room_id,
            } => {
                assert_eq!(name, "A");
                assert_eq!(reconnect_token, None);
                assert!(spectator);
                assert_eq!(room_id, None);
            }
            _ => panic!("expected hello message"),
        }
    }

    #[test]
    fn parse_hello_message_with_room_id() {
        let parsed = parse_client_message(r#"{"type":"hello","name":"A","roomId":"main"}"#)
            .expect("hello message should parse");
        match parsed {
            ParsedClientMessage::Hello { room_id, .. } => {
                assert_eq!(room_id.as_deref(), Some("main"));
            }
            _ => panic!("expected hello message"),
        }
    }

    #[test]
    fn parse_lobby_start_message() {
        let parsed = parse_client_message(
            r#"{"type":"lobby_start","difficulty":"hard","aiPlayerCount":5,"timeLimitMinutes":3}"#,
        )
        .expect("lobby start message should parse");
        match parsed {
            ParsedClientMessage::LobbyStart {
                difficulty,
                ai_player_count,
                time_limit_minutes,
            } => {
                assert_eq!(difficulty as Option<Difficulty>, Some(Difficulty::Hard));
                assert_eq!(ai_player_count, Some(5));
                assert_eq!(time_limit_minutes, Some(3));
            }
            _ => panic!("expected lobby_start message"),
        }
    }

    #[test]
    fn parse_input_rejects_invalid_direction() {
        let parsed = parse_client_message(r#"{"type":"input","dir":"invalid"}"#);
        assert!(parsed.is_none());
    }

    #[test]
    fn parse_input_accepts_none_direction() {
        let parsed = parse_client_message(r#"{"type":"input","dir":"none"}"#);
        assert!(matches!(
            parsed,
            Some(ParsedClientMessage::Input {
                dir: Some(Direction::None),
                ..
            })
        ));
    }

    #[test]
    fn parse_ping_requires_finite_number() {
        let parsed = parse_client_message(r#"{"type":"ping","t":12.5}"#);
        assert!(matches!(parsed, Some(ParsedClientMessage::Ping { .. })));
    }

    #[test]
    fn parse_place_ping_message() {
        let parsed = parse_client_message(r#"{"type":"place_ping","kind":"help"}"#);
        assert!(matches!(
            parsed,
            Some(ParsedClientMessage::PlacePing {
                kind: PingType::Help
            })
        ));
    }

    #[test]
    fn parse_lobby_start_floors_float_values() {
        let parsed = parse_client_message(
            r#"{"type":"lobby_start","aiPlayerCount":1.9,"timeLimitMinutes":-1.2}"#,
        )
        .expect("lobby start should parse");
        match parsed {
            ParsedClientMessage::LobbyStart {
                ai_player_count,
                time_limit_minutes,
                ..
            } => {
                assert_eq!(ai_player_count, Some(1));
                assert_eq!(time_limit_minutes, Some(-2));
            }
            _ => panic!("expected lobby_start message"),
        }
    }

    #[test]
    fn parse_lobby_start_rejects_overflow_numbers() {
        let parsed =
            parse_client_message(r#"{"type":"lobby_start","aiPlayerCount":18446744073709551615}"#);
        assert!(parsed.is_none());

        let parsed = parse_client_message(r#"{"type":"lobby_start","aiPlayerCount":1e100}"#);
        assert!(parsed.is_none());

        let parsed =
            parse_client_message(r#"{"type":"lobby_start","aiPlayerCount":-9223372036854775809}"#);
        assert!(parsed.is_none());

        let parsed =
            parse_client_message(r#"{"type":"lobby_start","aiPlayerCount":9.223372036854776e18}"#);
        assert!(parsed.is_none());
    }
}
