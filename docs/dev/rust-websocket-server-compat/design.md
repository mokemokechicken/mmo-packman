# Design: rust-websocket-server-compat

## Overview
`axum` + `tokio` を使って Rust WebSocket サーバー (`src/bin/server.rs`) を実装する。
ゲームロジックは既存 `GameEngine` を再利用し、ロビー状態と接続状態をメモリ上で管理する。

## Components
1. `ServerState`
   - clients
   - lobby players
   - active client mapping
   - host id
   - game engine instance
2. WebSocket handler
   - 受信: JSON parse → message dispatch
   - 送信: per-client bounded queue (`mpsc::channel`) へ `ServerMessage` JSON を push
   - queue 溢れ時は `state` を drop、制御メッセージは切断扱いにしてサーバー全体のメモリ増大を防ぐ
3. Tick loop
   - `TICK_MS` 間隔で `GameEngine::step`
   - `state` broadcast
   - 終了時 `game_over` broadcast + ロビー再開

## Security Notes
- 再接続トークンは連番ではなく CSPRNG で生成し、推測困難な値を用いる。

## Engine API Extensions
`GameEngine` に以下公開APIを追加する。
- `has_player(player_id)`
- `set_player_connection(player_id, connected)`
- `receive_input(player_id, dir, awaken)`

## Compatibility Test Strategy
`server.rs` に最小テストを追加する。
- クライアントメッセージのパース (`hello`, `lobby_start`, `input`, `ping`)
- `matchId` 等既存simulate機能への影響がないことは既存テストで担保

## Validation
1. `npm run check`
2. `npm run build`
3. `npm run test`
4. `cargo clippy --manifest-path rust/server/Cargo.toml --all-targets -- -D warnings`
5. `cargo test --manifest-path rust/server/Cargo.toml --all-targets`
6. `cargo run --manifest-path rust/server/Cargo.toml --bin server` 起動確認
