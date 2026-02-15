# Design: rust-protocol-sync

## Approach
1. `rust/server/src/types.rs` に `PingType` / `PingView` を追加し、`Snapshot` に `pings` を拡張する。
2. `rust/server/src/ping_manager.rs` を追加し、TTL・全体上限・プレイヤー上限・レート制御を管理する。
3. `server.rs` のメッセージパーサに `place_ping` を追加し、投稿者現在位置でピンを登録する。
4. `tick_game` と初回 state 送信で `snapshot.pings` を注入する。
5. `game_init` の payload に `seed` を追加する。
6. `roomId` は `main` のみサポートとし、他値は `error` を返す。

## Validation
- `npm run check`
- `npm run build`
- `npm run test`
- `cargo fmt --manifest-path rust/server/Cargo.toml --all --check`
- `cargo clippy --manifest-path rust/server/Cargo.toml --all-targets -- -D warnings`
- `cargo test --manifest-path rust/server/Cargo.toml --all-targets`
