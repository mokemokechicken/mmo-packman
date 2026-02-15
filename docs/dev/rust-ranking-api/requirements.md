# Requirements: rust-ranking-api

## Goal
Issue #65 の完了条件として、Rust サーバー実装で `GET /api/ranking` 契約を提供し、クライアント/ドキュメントとの齟齬を解消する。

## Functional Requirements
1. Rust サーバーは `GET /api/ranking?limit=<n>` を返却できること。
2. レスポンスは `generatedAtIso` と `entries[]` を含み、`entries` は `name, matches, wins, winRate, avgCaptureRatio, avgRescues, bestScore, updatedAtMs` を満たすこと。
3. `game_over` 発生時に human プレイヤーの戦績が更新されること（AI は除外）。
4. サーバー再起動後もランキングを復元できること（JSON 永続化）。

## Non-Functional Requirements
- 既存の WS ゲーム進行に回帰を入れない。
- `npm run check` / `npm run build` / `npm run test` / `cargo test --manifest-path rust/server/Cargo.toml --all-targets` を pass する。
