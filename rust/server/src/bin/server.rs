use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use mmo_packman_rust_server::constants::TICK_MS;
use mmo_packman_rust_server::engine::{GameEngine, GameEngineOptions};
use mmo_packman_rust_server::ping_manager::{PingManager, PingManagerOptions, PlacePingInput};
use mmo_packman_rust_server::ranking_store::RankingStore;
use mmo_packman_rust_server::types::{Difficulty, Direction, PingType, StartPlayer};
use rand::distr::Alphanumeric;
use rand::Rng;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};
use tower_http::services::{ServeDir, ServeFile};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

type SharedState = Arc<Mutex<ServerState>>;

#[derive(Clone, Debug)]
struct LobbyPlayerInternal {
    id: String,
    name: String,
    connected: bool,
    ai: bool,
    spectator: bool,
    reconnect_token: String,
}

#[derive(Clone)]
struct ClientContext {
    tx: mpsc::Sender<OutboundMessage>,
    player_id: Option<String>,
}

#[derive(Clone, Debug)]
enum OutboundMessage {
    Text(String),
    Close { code: u16, reason: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueuePolicy {
    DropOnFull,
    DisconnectOnFull,
}

struct ServerState {
    clients: HashMap<String, ClientContext>,
    lobby_players: HashMap<String, LobbyPlayerInternal>,
    active_client_by_player_id: HashMap<String, String>,
    host_id: Option<String>,
    game: Option<GameEngine>,
    running_ai_count: usize,
    ranking_store: RankingStore,
    ping_manager: PingManager,
}

impl ServerState {
    fn new(ranking_store: RankingStore) -> Self {
        Self {
            clients: HashMap::new(),
            lobby_players: HashMap::new(),
            active_client_by_player_id: HashMap::new(),
            host_id: None,
            game: None,
            running_ai_count: 0,
            ranking_store,
            ping_manager: PingManager::new(PingManagerOptions::default()),
        }
    }
}

#[derive(Debug, Deserialize)]
struct RankingQuery {
    limit: Option<String>,
}

#[derive(Debug)]
enum ParsedClientMessage {
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

#[tokio::main]
async fn main() {
    let port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8080);

    let ranking_path = std::env::var("RANKING_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(".data/ranking.json"));

    let state = Arc::new(Mutex::new(ServerState::new(RankingStore::new(
        ranking_path,
    ))));
    start_tick_loop(state.clone());

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/ranking", get(ranking_handler))
        .route("/ws", get(ws_handler))
        .with_state(state);

    let app = if let Some(static_dir) = resolve_static_dir() {
        let index_file = static_dir.join("index.html");
        println!(
            "[server] static file root: {}",
            static_dir.to_string_lossy()
        );
        app.fallback_service(
            ServeDir::new(static_dir).not_found_service(ServeFile::new(index_file)),
        )
    } else {
        eprintln!(
            "[server] static file root not found. run `npm run build` to generate dist/client."
        );
        app
    };

    let bind_addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .expect("failed to bind server socket");

    println!("[server] listening on :{port}");
    axum::serve(listener, app)
        .await
        .expect("server runtime failed");
}

fn resolve_static_dir() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("STATIC_DIR") {
        let path = PathBuf::from(raw);
        if path.join("index.html").is_file() {
            return Some(path);
        }
    }

    let candidates = [
        PathBuf::from("dist/client"),
        PathBuf::from("../../dist/client"),
    ];
    candidates
        .into_iter()
        .find(|path| path.join("index.html").is_file())
}

async fn healthz() -> impl IntoResponse {
    Json(json!({ "ok": true }))
}

async fn ranking_handler(
    State(state): State<SharedState>,
    Query(query): Query<RankingQuery>,
) -> impl IntoResponse {
    let guard = state.lock().await;
    Json(
        guard
            .ranking_store
            .build_response(parse_ranking_limit(query.limit.as_deref())),
    )
}

fn parse_ranking_limit(raw: Option<&str>) -> Option<usize> {
    raw.and_then(|value| value.parse::<usize>().ok())
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<SharedState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(state, socket))
}

async fn handle_socket(state: SharedState, socket: WebSocket) {
    let client_id = make_id("client");
    let (tx, mut rx) = mpsc::channel::<OutboundMessage>(256);

    {
        let mut guard = state.lock().await;
        guard.clients.insert(
            client_id.clone(),
            ClientContext {
                tx: tx.clone(),
                player_id: None,
            },
        );
    }

    let (mut ws_sender, mut ws_receiver) = socket.split();
    let writer = tokio::spawn(async move {
        while let Some(outbound) = rx.recv().await {
            let should_close = matches!(outbound, OutboundMessage::Close { .. });
            let result = match outbound {
                OutboundMessage::Text(payload) => {
                    ws_sender.send(Message::Text(payload.into())).await
                }
                OutboundMessage::Close { code, reason } => {
                    let frame = CloseFrame {
                        code,
                        reason: reason.into(),
                    };
                    ws_sender.send(Message::Close(Some(frame))).await
                }
            };
            if result.is_err() || should_close {
                break;
            }
        }
    });

    while let Some(received) = ws_receiver.next().await {
        let Ok(message) = received else {
            break;
        };

        match message {
            Message::Text(raw) => {
                handle_client_message(state.clone(), &client_id, raw.to_string()).await;
            }
            Message::Binary(raw) => {
                if let Ok(text) = String::from_utf8(raw.to_vec()) {
                    handle_client_message(state.clone(), &client_id, text).await;
                } else {
                    send_error_to_client(&state, &client_id, "invalid utf8 message").await;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    handle_disconnect(state, &client_id).await;
    drop(tx);
    let _ = writer.await;
}

async fn handle_client_message(state: SharedState, client_id: &str, raw: String) {
    let Some(message) = parse_client_message(&raw) else {
        send_error_to_client(&state, client_id, "invalid message").await;
        return;
    };

    match message {
        ParsedClientMessage::Hello {
            name,
            reconnect_token,
            spectator,
            room_id,
        } => {
            handle_hello(state, client_id, name, reconnect_token, spectator, room_id).await;
        }
        ParsedClientMessage::Ping { t } => {
            let mut guard = state.lock().await;
            send_to_client(
                &mut guard,
                client_id,
                &json!({
                    "type": "pong",
                    "t": t,
                }),
                QueuePolicy::DisconnectOnFull,
            );
        }
        ParsedClientMessage::LobbyStart {
            difficulty,
            ai_player_count,
            time_limit_minutes,
        } => {
            let player_id = {
                let guard = state.lock().await;
                guard
                    .clients
                    .get(client_id)
                    .and_then(|ctx| ctx.player_id.clone())
            };
            let Some(player_id) = player_id else {
                send_error_to_client(&state, client_id, "send hello first").await;
                return;
            };
            handle_lobby_start(
                state,
                &player_id,
                difficulty.unwrap_or(Difficulty::Normal),
                ai_player_count,
                time_limit_minutes,
            )
            .await;
        }
        ParsedClientMessage::Input { dir, awaken } => {
            let player_id = {
                let guard = state.lock().await;
                guard
                    .clients
                    .get(client_id)
                    .and_then(|ctx| ctx.player_id.clone())
            };
            let Some(player_id) = player_id else {
                send_error_to_client(&state, client_id, "send hello first").await;
                return;
            };
            let mut guard = state.lock().await;
            if let Some(game) = guard.game.as_mut() {
                game.receive_input(&player_id, dir, awaken);
            }
        }
        ParsedClientMessage::PlacePing { kind } => {
            let player_id = {
                let guard = state.lock().await;
                guard
                    .clients
                    .get(client_id)
                    .and_then(|ctx| ctx.player_id.clone())
            };
            let Some(player_id) = player_id else {
                send_error_to_client(&state, client_id, "send hello first").await;
                return;
            };
            let mut guard = state.lock().await;
            let Some(member) = guard.lobby_players.get(&player_id).cloned() else {
                send_to_client(
                    &mut guard,
                    client_id,
                    &json!({
                        "type": "error",
                        "message": "player is not in lobby",
                    }),
                    QueuePolicy::DisconnectOnFull,
                );
                return;
            };
            let Some(game) = guard.game.as_mut() else {
                send_to_client(
                    &mut guard,
                    client_id,
                    &json!({
                        "type": "error",
                        "message": "game is not running",
                    }),
                    QueuePolicy::DisconnectOnFull,
                );
                return;
            };
            if member.spectator {
                send_to_client(
                    &mut guard,
                    client_id,
                    &json!({
                        "type": "error",
                        "message": "spectator cannot place ping",
                    }),
                    QueuePolicy::DisconnectOnFull,
                );
                return;
            }

            let Some(pos) = game.player_position(&player_id) else {
                send_to_client(
                    &mut guard,
                    client_id,
                    &json!({
                        "type": "error",
                        "message": "player is not in current game",
                    }),
                    QueuePolicy::DisconnectOnFull,
                );
                return;
            };
            let now_ms = game.current_now_ms();

            let result = guard.ping_manager.place(PlacePingInput {
                owner_id: player_id,
                owner_name: member.name,
                x: pos.x,
                y: pos.y,
                kind,
                now_ms,
                spectator: member.spectator,
            });
            if !result.ok {
                send_to_client(
                    &mut guard,
                    client_id,
                    &json!({
                        "type": "error",
                        "message": result.reason.unwrap_or_else(|| "failed to place ping".to_string()),
                    }),
                    QueuePolicy::DisconnectOnFull,
                );
            }
        }
    }
}

async fn handle_hello(
    state: SharedState,
    client_id: &str,
    requested_name: String,
    reconnect_token: Option<String>,
    spectator_requested: bool,
    requested_room_id: Option<String>,
) {
    let mut guard = state.lock().await;
    if !is_supported_room(requested_room_id.as_deref()) {
        send_to_client(
            &mut guard,
            client_id,
            &json!({
                "type": "error",
                "message": "roomId is not supported on rust server yet. use 'main'.",
            }),
            QueuePolicy::DisconnectOnFull,
        );
        return;
    }
    let name = sanitize_name(&requested_name);

    let current_player_id = guard
        .clients
        .get(client_id)
        .and_then(|ctx| ctx.player_id.clone());

    if let Some(current_player_id) = current_player_id {
        let mismatch = if let Some(member) = guard.lobby_players.get(&current_player_id) {
            reconnect_token
                .as_deref()
                .map(|token| token != member.reconnect_token)
                .unwrap_or(false)
        } else {
            false
        };

        if mismatch {
            send_to_client(
                &mut guard,
                client_id,
                &json!({
                    "type": "error",
                    "message": "reconnect token mismatch for this connection",
                }),
                QueuePolicy::DisconnectOnFull,
            );
            return;
        }

        if guard.lobby_players.contains_key(&current_player_id) {
            let running = guard.game.is_some();
            if let Some(member) = guard.lobby_players.get_mut(&current_player_id) {
                if !running {
                    member.spectator = spectator_requested;
                }
                member.name = name.clone();
                member.connected = true;
                member.ai = false;
            }

            bind_client_to_player(&mut guard, client_id, &current_player_id);

            let spectator = guard
                .lobby_players
                .get(&current_player_id)
                .map(|member| member.spectator)
                .unwrap_or(false);
            if !spectator {
                if let Some(game) = guard.game.as_mut() {
                    if game.has_player(&current_player_id) {
                        game.set_player_connection(&current_player_id, true);
                    }
                }
            }

            ensure_host_assigned(&mut guard, Some(current_player_id.clone()));
            send_welcome_and_initial_state(&mut guard, client_id, &current_player_id);
            broadcast_lobby(&mut guard, None);
            return;
        }

        if let Some(client) = guard.clients.get_mut(client_id) {
            client.player_id = None;
        }
    }

    if let Some(token) = reconnect_token.clone() {
        if let Some(existing_id) = find_player_id_by_token(&guard, &token) {
            let game_has_player = guard
                .game
                .as_ref()
                .map(|game| game.has_player(&existing_id))
                .unwrap_or(false);
            let existing_spectator = guard
                .lobby_players
                .get(&existing_id)
                .map(|member| member.spectator)
                .unwrap_or(false);

            if guard.game.is_some() && !existing_spectator && !game_has_player {
                send_to_client(
                    &mut guard,
                    client_id,
                    &json!({
                        "type": "error",
                        "message": "game already running; reconnection only",
                    }),
                    QueuePolicy::DisconnectOnFull,
                );
                return;
            }

            let game_running = guard.game.is_some();
            if let Some(member) = guard.lobby_players.get_mut(&existing_id) {
                if !game_running {
                    member.spectator = spectator_requested;
                }
                member.name = name;
                member.connected = true;
                member.ai = false;
            }

            bind_client_to_player(&mut guard, client_id, &existing_id);

            let spectator = guard
                .lobby_players
                .get(&existing_id)
                .map(|member| member.spectator)
                .unwrap_or(false);
            if !spectator {
                if let Some(game) = guard.game.as_mut() {
                    if game.has_player(&existing_id) {
                        game.set_player_connection(&existing_id, true);
                    }
                }
            }

            ensure_host_assigned(&mut guard, Some(existing_id.clone()));
            send_welcome_and_initial_state(&mut guard, client_id, &existing_id);
            broadcast_lobby(&mut guard, None);
            return;
        }
    }

    if guard.game.is_some() && !spectator_requested {
        send_to_client(
            &mut guard,
            client_id,
            &json!({
                "type": "error",
                "message": "game already running; reconnection or spectator only",
            }),
            QueuePolicy::DisconnectOnFull,
        );
        return;
    }

    let player_id = make_id("player");
    let token = make_reconnect_token();
    let player = LobbyPlayerInternal {
        id: player_id.clone(),
        name,
        connected: true,
        ai: false,
        spectator: spectator_requested,
        reconnect_token: token,
    };

    guard.lobby_players.insert(player_id.clone(), player);
    bind_client_to_player(&mut guard, client_id, &player_id);
    ensure_host_assigned(&mut guard, Some(player_id.clone()));
    send_welcome_and_initial_state(&mut guard, client_id, &player_id);
    broadcast_lobby(&mut guard, None);
}

async fn handle_lobby_start(
    state: SharedState,
    requested_by: &str,
    difficulty: Difficulty,
    ai_player_count: Option<i64>,
    time_limit_minutes: Option<i64>,
) {
    let mut guard = state.lock().await;
    if guard.game.is_some() {
        return;
    }

    ensure_host_assigned(&mut guard, None);
    if guard.host_id.as_deref() != Some(requested_by) {
        if let Some(client_id) = guard.active_client_by_player_id.get(requested_by).cloned() {
            send_to_client(
                &mut guard,
                &client_id,
                &json!({
                    "type": "error",
                    "message": "only host can start",
                }),
                QueuePolicy::DisconnectOnFull,
            );
        }
        return;
    }

    let mut human_ids: Vec<String> = guard
        .lobby_players
        .values()
        .filter(|player| player.connected && !player.spectator)
        .map(|player| player.id.clone())
        .collect();
    human_ids.sort_by_key(|id| player_order_key(id));

    let mut start_players = Vec::new();
    for player_id in &human_ids {
        let Some(player) = guard.lobby_players.get(player_id) else {
            continue;
        };
        start_players.push(StartPlayer {
            id: player.id.clone(),
            name: player.name.clone(),
            reconnect_token: player.reconnect_token.clone(),
            connected: player.connected,
        });
    }

    let ai_count = normalize_ai_count(ai_player_count);
    for idx in 0..ai_count {
        start_players.push(StartPlayer {
            id: format!("ai_{}", make_id("id")),
            name: format!("AI-{:02}", idx + 1),
            reconnect_token: make_reconnect_token(),
            connected: false,
        });
    }

    if start_players.is_empty() {
        if let Some(client_id) = guard.active_client_by_player_id.get(requested_by).cloned() {
            send_to_client(
                &mut guard,
                &client_id,
                &json!({
                    "type": "error",
                    "message": "no players. set AI players or join as player.",
                }),
                QueuePolicy::DisconnectOnFull,
            );
        }
        return;
    }

    guard.running_ai_count = ai_count;
    guard.ping_manager.clear();
    guard.game = Some(GameEngine::new(
        start_players,
        difficulty,
        now_ms() as u32,
        GameEngineOptions {
            time_limit_ms_override: normalize_time_limit_ms(time_limit_minutes),
        },
    ));

    let player_ids: Vec<String> = guard.lobby_players.keys().cloned().collect();
    for player_id in player_ids {
        let game_has_player = guard.game.as_ref().map(|game| game.has_player(&player_id));
        let mut remove_player = false;
        if let Some(player) = guard.lobby_players.get_mut(&player_id) {
            if player.spectator {
                player.ai = false;
            } else if let Some(game_has_player) = game_has_player {
                if game_has_player {
                    player.ai = !player.connected;
                } else {
                    remove_player = true;
                }
            }
        }

        if remove_player {
            guard.lobby_players.remove(&player_id);
            guard.active_client_by_player_id.remove(&player_id);
        }
    }

    let (world, config, started_at_ms, seed, start_note) = {
        let game = guard
            .game
            .as_ref()
            .expect("game should be initialized before notifying clients");
        (
            game.get_world_init(),
            game.config.clone(),
            game.started_at_ms,
            game.seed(),
            format!(
                "ゲーム開始 (human:{}, ai:{}, limit:{}m)",
                human_ids.len(),
                ai_count,
                game.config.time_limit_ms / 60_000
            ),
        )
    };

    broadcast_lobby(&mut guard, Some(start_note));

    let members: Vec<LobbyPlayerInternal> = guard
        .lobby_players
        .values()
        .filter(|member| member.connected)
        .cloned()
        .collect();
    for member in members {
        if let Some(client_id) = guard.active_client_by_player_id.get(&member.id).cloned() {
            send_to_client(
                &mut guard,
                &client_id,
                &json!({
                    "type": "game_init",
                    "meId": member.id,
                    "world": world,
                    "config": config,
                    "startedAtMs": started_at_ms,
                    "seed": seed,
                    "isSpectator": member.spectator,
                }),
                QueuePolicy::DisconnectOnFull,
            );
        }
    }
}

async fn handle_disconnect(state: SharedState, client_id: &str) {
    let mut guard = state.lock().await;
    disconnect_client_internal(&mut guard, client_id, true);
}

fn disconnect_client_internal(state: &mut ServerState, client_id: &str, broadcast_after: bool) {
    let Some(context) = state.clients.remove(client_id) else {
        return;
    };
    let Some(bound_player_id) = context.player_id else {
        return;
    };

    if state
        .active_client_by_player_id
        .get(&bound_player_id)
        .map(|active| active != client_id)
        .unwrap_or(true)
    {
        return;
    }

    state.active_client_by_player_id.remove(&bound_player_id);

    let game_running = state.game.is_some();
    let mut remove_member = false;
    if let Some(member) = state.lobby_players.get_mut(&bound_player_id) {
        if game_running {
            if member.spectator {
                remove_member = true;
            } else {
                member.connected = false;
                member.ai = true;
                if let Some(game) = state.game.as_mut() {
                    if game.has_player(&bound_player_id) {
                        game.set_player_connection(&bound_player_id, false);
                    }
                }
            }
        } else {
            remove_member = true;
        }
    }

    if remove_member {
        state.lobby_players.remove(&bound_player_id);
        state.active_client_by_player_id.remove(&bound_player_id);
    }

    if state.host_id.as_deref() == Some(&bound_player_id) {
        state.host_id = choose_next_host(state);
    }

    if broadcast_after {
        broadcast_lobby(state, None);
    }
}

fn send_welcome_and_initial_state(state: &mut ServerState, client_id: &str, player_id: &str) {
    let Some(member) = state.lobby_players.get(player_id).cloned() else {
        return;
    };

    send_to_client(
        state,
        client_id,
        &json!({
            "type": "welcome",
            "playerId": member.id,
            "reconnectToken": member.reconnect_token,
            "isHost": state.host_id.as_deref() == Some(player_id),
            "isSpectator": member.spectator,
        }),
        QueuePolicy::DisconnectOnFull,
    );

    if state.game.is_none() {
        return;
    }

    let (world, config, started_at_ms, seed, mut snapshot) = {
        let game = state
            .game
            .as_mut()
            .expect("game should exist while preparing initial state");
        (
            game.get_world_init(),
            game.config.clone(),
            game.started_at_ms,
            game.seed(),
            game.build_snapshot(false),
        )
    };
    snapshot.pings = state.ping_manager.snapshot(snapshot.now_ms);

    send_to_client(
        state,
        client_id,
        &json!({
            "type": "game_init",
            "meId": member.id,
            "world": world,
            "config": config,
            "startedAtMs": started_at_ms,
            "seed": seed,
            "isSpectator": member.spectator,
        }),
        QueuePolicy::DisconnectOnFull,
    );

    send_to_client(
        state,
        client_id,
        &json!({
            "type": "state",
            "snapshot": snapshot,
        }),
        QueuePolicy::DisconnectOnFull,
    );
}

fn bind_client_to_player(state: &mut ServerState, client_id: &str, player_id: &str) {
    if let Some(old_client_id) = state.active_client_by_player_id.get(player_id).cloned() {
        if old_client_id != client_id {
            if let Some(old_client) = state.clients.get_mut(&old_client_id) {
                old_client.player_id = None;
                let _ = old_client.tx.try_send(OutboundMessage::Close {
                    code: 4001,
                    reason: "superseded by new connection".to_string(),
                });
            }
        }
    }

    let previous_player_id = state
        .clients
        .get(client_id)
        .and_then(|ctx| ctx.player_id.clone());
    if let Some(previous_player_id) = previous_player_id {
        if previous_player_id != player_id {
            state.active_client_by_player_id.remove(&previous_player_id);
        }
    }

    if let Some(ctx) = state.clients.get_mut(client_id) {
        ctx.player_id = Some(player_id.to_string());
    }
    state
        .active_client_by_player_id
        .insert(player_id.to_string(), client_id.to_string());
}

fn broadcast_lobby(state: &mut ServerState, note: Option<String>) {
    ensure_host_assigned(state, None);

    let mut players: Vec<LobbyPlayerInternal> = state.lobby_players.values().cloned().collect();
    players.sort_by(|a, b| a.name.cmp(&b.name));

    let spectator_count = players.iter().filter(|player| player.spectator).count();
    let can_start = state
        .host_id
        .as_ref()
        .and_then(|host_id| state.lobby_players.get(host_id))
        .map(|host| host.connected)
        .unwrap_or(false);

    let composed_note = if state.running_ai_count > 0 && note.is_none() {
        Some(format!("AI稼働中: {}", state.running_ai_count))
    } else {
        note
    };

    let players_payload: Vec<Value> = players
        .iter()
        .map(|player| {
            json!({
                "id": player.id,
                "name": player.name,
                "connected": player.connected,
                "ai": player.ai,
                "spectator": player.spectator,
                "isHost": state.host_id.as_deref() == Some(player.id.as_str()),
            })
        })
        .collect();

    broadcast(
        state,
        &json!({
            "type": "lobby",
            "players": players_payload,
            "hostId": state.host_id,
            "canStart": can_start,
            "running": state.game.is_some(),
            "spectatorCount": spectator_count,
            "note": composed_note,
        }),
        QueuePolicy::DisconnectOnFull,
    );
}

fn start_tick_loop(state: SharedState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(TICK_MS));
        loop {
            interval.tick().await;
            let mut guard = state.lock().await;
            tick_game(&mut guard);
        }
    });
}

fn tick_game(state: &mut ServerState) {
    let mut snapshot = {
        let Some(game) = state.game.as_mut() else {
            return;
        };
        game.step(TICK_MS);
        game.build_snapshot(true)
    };
    snapshot.pings = state.ping_manager.snapshot(snapshot.now_ms);

    broadcast(
        state,
        &json!({
            "type": "state",
            "snapshot": snapshot,
        }),
        QueuePolicy::DropOnFull,
    );

    let summary = {
        let Some(game) = state.game.as_ref() else {
            return;
        };
        if game.is_ended() {
            Some(game.build_summary())
        } else {
            None
        }
    };

    if let Some(summary) = summary {
        state.ranking_store.record_match(&summary);
        broadcast(
            state,
            &json!({
                "type": "game_over",
                "summary": summary,
            }),
            QueuePolicy::DisconnectOnFull,
        );

        state.game = None;
        state.running_ai_count = 0;
        state.ping_manager.clear();
        for player in state.lobby_players.values_mut() {
            player.ai = false;
        }

        ensure_host_assigned(state, None);
        broadcast_lobby(state, Some("ゲーム終了。再スタート可能です".to_string()));
    }
}

fn send_to_client(state: &mut ServerState, client_id: &str, message: &Value, policy: QueuePolicy) {
    let send_failed = if let Some(client) = state.clients.get(client_id) {
        client
            .tx
            .try_send(OutboundMessage::Text(message.to_string()))
            .is_err()
    } else {
        false
    };
    if send_failed && policy == QueuePolicy::DisconnectOnFull {
        disconnect_client_internal(state, client_id, false);
    }
}

fn broadcast(state: &mut ServerState, message: &Value, policy: QueuePolicy) {
    let payload = message.to_string();
    let client_ids: Vec<String> = state.clients.keys().cloned().collect();
    let mut failed_clients = Vec::new();
    for client_id in client_ids {
        let Some(client) = state.clients.get(&client_id) else {
            continue;
        };
        if !can_receive_broadcast(state, &client_id, client) {
            continue;
        }
        if client
            .tx
            .try_send(OutboundMessage::Text(payload.clone()))
            .is_err()
            && policy == QueuePolicy::DisconnectOnFull
        {
            failed_clients.push(client_id);
        }
    }
    if policy == QueuePolicy::DisconnectOnFull {
        for client_id in failed_clients {
            disconnect_client_internal(state, &client_id, false);
        }
    }
}

fn can_receive_broadcast(state: &ServerState, client_id: &str, client: &ClientContext) -> bool {
    let Some(player_id) = client.player_id.as_ref() else {
        return false;
    };
    if state
        .active_client_by_player_id
        .get(player_id)
        .map(|id| id.as_str())
        != Some(client_id)
    {
        return false;
    }
    state.lobby_players.contains_key(player_id)
}

async fn send_error_to_client(state: &SharedState, client_id: &str, message: &str) {
    let mut guard = state.lock().await;
    send_to_client(
        &mut guard,
        client_id,
        &json!({
            "type": "error",
            "message": message,
        }),
        QueuePolicy::DisconnectOnFull,
    );
}

fn ensure_host_assigned(state: &mut ServerState, preferred_player_id: Option<String>) {
    if state
        .host_id
        .as_ref()
        .and_then(|host_id| state.lobby_players.get(host_id))
        .map(|host| host.connected)
        .unwrap_or(false)
    {
        return;
    }

    if let Some(preferred_player_id) = preferred_player_id {
        if state
            .lobby_players
            .get(&preferred_player_id)
            .map(|player| player.connected)
            .unwrap_or(false)
        {
            state.host_id = Some(preferred_player_id);
            return;
        }
    }

    state.host_id = choose_next_host(state);
}

fn choose_next_host(state: &ServerState) -> Option<String> {
    let mut connected: Vec<&LobbyPlayerInternal> = state
        .lobby_players
        .values()
        .filter(|player| player.connected)
        .collect();
    connected.sort_by_key(|player| player_order_key(&player.id));
    connected.first().map(|player| player.id.clone())
}

fn find_player_id_by_token(state: &ServerState, token: &str) -> Option<String> {
    state
        .lobby_players
        .values()
        .find(|player| player.reconnect_token == token)
        .map(|player| player.id.clone())
}

fn sanitize_name(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "Player".to_string();
    }
    trimmed.chars().take(16).collect()
}

fn is_supported_room(raw: Option<&str>) -> bool {
    match raw {
        None => true,
        Some(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            normalized == "main"
        }
    }
}

fn normalize_ai_count(value: Option<i64>) -> usize {
    value.unwrap_or(0).clamp(0, 100) as usize
}

fn normalize_time_limit_ms(value: Option<i64>) -> Option<u64> {
    value.map(|minutes| minutes.clamp(1, 10) as u64 * 60_000)
}

fn player_order_key(player_id: &str) -> u64 {
    player_id
        .rsplit('_')
        .next()
        .and_then(|suffix| suffix.parse::<u64>().ok())
        .unwrap_or(u64::MAX)
}

fn parse_client_message(raw: &str) -> Option<ParsedClientMessage> {
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
            if floored < i64::MIN as f64 || floored > i64::MAX as f64 {
                return None;
            }
            return Some(Some(floored as i64));
        }
    }
    None
}

fn make_id(prefix: &str) -> String {
    let seq = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{seq}")
}

fn make_reconnect_token() -> String {
    rand::rng()
        .sample_iter(Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
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
}
