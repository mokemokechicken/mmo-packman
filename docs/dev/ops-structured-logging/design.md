# Design: ops-structured-logging

## Overview
`rust/server/src/bin/simulate.rs` に構造化ログの共通フォーマットを追加し、
- 試合開始/終了
- 異常検知
- 実行サマリ
を JSONL で出力する。必要に応じてサマリをファイルへ保存できるようにする。

## CLI Changes
- `--match-id <string>`: ログ集約キー。未指定時は seed/時刻から自動生成。
- `--summary-out <path>`: 全シナリオ完了後の集約サマリ JSON を保存。

## Data Model
- `StructuredLogLine`
  - `level`: `info|warn|error`
  - `event`: `scenario_started|scenario_finished|anomaly_detected|run_finished`
  - `matchId`, `scenario`, `seed`, `tick`
  - `details`: 可変メタデータ
- `RunSummary`
  - 各シナリオ結果（既存 `ScenarioResultLine`）
  - 集計値（異常件数、終了理由別件数、平均試合時間）

## Validation Plan
1. `npm run check`
2. `npm run build`
3. `npm run test`
4. `cargo test --manifest-path rust/server/Cargo.toml --all-targets`
5. `cargo run --manifest-path rust/server/Cargo.toml --bin simulate -- --single --ai 5 --minutes 3 --difficulty normal --seed 42 --match-id local-test --summary-out /tmp/mmo-packman-summary.json`

## Rollout Notes
- 既存の JSON result line は維持し、追加ログを同時出力する。
- Cloud Run では `event` フィールドでフィルタし、`anomaly_detected` を重点監視する。
