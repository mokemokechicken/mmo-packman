# Design: result-detailed-awards

## Approach
1. Rust 側 `GameSummary` に `awards` フィールドを追加し、`ScoreEntry` からカテゴリ別最大値を抽出して受賞者を決定する。
2. 表彰カテゴリは MVP 相当の主要軸として以下を採用する。
   - `rescue_king`（救助王）: `rescues`
   - `explorer_king`（探索王）: `dots`
   - `defense_king`（防衛王）: `captures`
   - `ghost_hunter`（ゴーストハンター）: `ghosts`
3. すべて 0 件のカテゴリは表彰対象外として `awards` から除外し、ノイズ表示を避ける。
4. クライアントでは `summary.awards` をレンダリングし、同率受賞時は複数名を併記する。
5. サーバープロトコル文書に `game_over.summary.awards` の JSON 例を追記する。

## Validation
- `cargo test --manifest-path rust/server/Cargo.toml --all-targets`
- `npm run check`
- `npm run build`
- `npm run test`
