# Design: rust-ranking-api

## Approach
1. `rust/server/src/ranking_store.rs` を新規追加し、戦績集計・JSON保存/読込・ソート済みレスポンス生成を担当させる。
2. `ServerState` に `RankingStore` を保持し、`tick_game` の `game_over` で `record_match` を呼ぶ。
3. Axum ルータに `GET /api/ranking` を追加し、`limit` クエリを受けて `RankingResponse` を返す。
4. shared 契約に合わせた `PersistentRankingEntry` / `RankingResponse` を Rust 側 `types.rs` に追加する。

## Validation
- `npm run check`
- `npm run build`
- `npm run test`
- `cargo test --manifest-path rust/server/Cargo.toml --all-targets`
- `curl http://localhost:8080/api/ranking?limit=8`
