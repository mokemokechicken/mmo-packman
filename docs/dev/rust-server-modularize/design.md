# Design: rust-server-modularize

## Approach
1. `rust/server/src/server_protocol.rs` を追加し、`ParsedClientMessage` と JSON パーサを移管する。
2. `rust/server/src/server_utils.rs` を追加し、name/room/limit/host-order 等の正規化ロジックを移管する。
3. `server.rs` は「状態遷移と送受信制御」に集中させる。
4. パーサ/ユーティリティの unit test を新モジュール側へ移し、責務ごとのテストを明確化する。

## Validation
- `cargo fmt --manifest-path rust/server/Cargo.toml --all --check`
- `cargo clippy --manifest-path rust/server/Cargo.toml --all-targets -- -D warnings`
- `cargo test --manifest-path rust/server/Cargo.toml --all-targets`
- `npm run check`
- `npm run build`
- `npm run test`
