# Requirements: rust-server-modularize

## Goal
Issue #67 の完了条件として、`rust/server/src/bin/server.rs` の多責務を分離し、プロトコル解釈と運用ロジックの変更影響範囲を小さくする。

## Functional Requirements
1. クライアントメッセージのパース責務を `server.rs` から切り出すこと。
2. 入力正規化/検証のユーティリティ責務を切り出すこと。
3. 既存の WS 接続・ロビー・試合進行の挙動を維持すること。

## Non-Functional Requirements
- `cargo fmt --manifest-path rust/server/Cargo.toml --all --check`
- `cargo clippy --manifest-path rust/server/Cargo.toml --all-targets -- -D warnings`
- `cargo test --manifest-path rust/server/Cargo.toml --all-targets`
- `npm run check` / `npm run build` / `npm run test`
