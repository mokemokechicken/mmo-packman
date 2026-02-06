# Requirements: rust-websocket-server-compat

## Goal
Rust バイナリで WebSocket サーバーを起動し、既存クライアントのロビー/対戦/再接続/観戦フローを TypeScript 互換プロトコルで動作させる。

## Functional Requirements
1. `rust/server` に WebSocket サーバーバイナリを追加し、`/ws` エンドポイントを提供すること。
2. 以下メッセージ契約を満たすこと（`docs/server_protocol.md` 準拠）
   - Client: `hello`, `lobby_start`, `input`, `ping`
   - Server: `welcome`, `lobby`, `game_init`, `state`, `game_over`, `error`, `pong`
3. 参加/観戦/再接続が動作すること。
4. 試合進行ループで `state` を継続配信し、終了時に `game_over` を配信すること。
5. ヘルスチェック (`/healthz`) を提供すること。

## Non-Functional Requirements
- 既存 `simulate` バイナリの挙動を壊さないこと。
- Cloud Run 想定で `PORT` 環境変数で待受ポートを変更できること。

## Out of Scope
- 認証/認可
- 永続化
- ルームID複数同時試合（別Issue）
