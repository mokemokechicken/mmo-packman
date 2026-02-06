# Design: balance-ai-substitution-resilience

## Approach
1. `update_player_ai` の優先順を「即時危険回避 -> 救助対象探索 -> 通常行動」に固定する。
2. AI意思決定に危険評価（最寄りゴースト距離）を反映し、近距離では逃走・覚醒を優先する。
3. 救助接近時は、ダウン地点周辺の危険度に応じて覚醒を自動発動する。
4. 単体テストで「救助方向を選ぶ」「危険救助時に覚醒要求する」「安全探索で隣接ゴーストセルを避ける」を検証する。
5. AI思考間隔を `90-190ms` に短縮し、少人数時の救助反応遅延を抑える。
6. 方向選択ロジックは `sector_system.rs` に集約し、`mod.rs` は優先順位オーケストレーションに限定する。

## Validation
- `cargo test --manifest-path rust/server/Cargo.toml --all-targets`
- `npm run check`
- `npm run build`
- `npm run test`
- `npm run simulate -- --single --ai 2 --minutes 10 --difficulty casual --seed 1001`（代表確認）
- `AI x2 / casual / seed 1001-1010` の集計で `allDownRate <= 20%` と `avgMaxCapture >= 5.0%` を評価し、`avgRescues` を監視する
