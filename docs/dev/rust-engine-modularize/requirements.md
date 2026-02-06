# Requirements: rust-engine-modularize

## Goal
Rustサーバーの `engine` 実装を責務単位で分割し、保守性とレビュー容易性を高める。

## Functional Requirements
1. `rust/server/src/engine.rs` の主要責務を複数ファイルへ分割する。
2. 既存挙動（simulate結果と既存テスト）を維持する。
3. Rust実装を dev ブランチへ統合する。

## Non-Functional Requirements
- `cargo test --all-targets` / `cargo clippy --all-targets -- -D warnings` が通ること。
- TypeScript側ビルド・チェックを壊さないこと。
