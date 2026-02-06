# Design: ts-rust-parity-harness

## Architecture
- `src/server/parity_harness.ts` を追加する。
- ハーネスは `npm run simulate` と `npm run simulate:rust` を child process で実行し、JSON Lines をパースして比較する。
- 比較は 1 scenario x 1 seed を最小単位にし、失敗したケースを蓄積して最後にレポートする。
- `anomalies` 由来の終了コード 1 は許容し、JSON結果を取り込んで `anomalies.length` を比較する。
- 1 seed の実行エラーはそのseedの failure として記録し、残りseedの検証は継続する。

## Scenario/Seed Strategy
- デフォルト: `--ai 5 --minutes 3 --difficulty normal` で 10 seeds を実行。
- `--seeds`（カンマ区切り）または `--seed-start` + `--seed-count` でカスタマイズ可能にする。

## Comparison Policy
- 完全一致:
  - `reason`
  - `anomalies.length`
  - 各イベント集計値
- 許容誤差比較:
  - `maxCapture`, `minCaptureAfter70` は ±0.2 ポイント以内
- 失敗時は以下を出力:
  - seed / scenario / 実行条件
  - TS結果
  - Rust結果
  - 差分項目一覧

## CI Integration
- CI に parity step を追加し、軽量設定（例: 4 seeds x 1 minute）で毎回実行する。
- parity step は当面 non-blocking（`continue-on-error`）で運用し、差分レポートをartifactとして保存する。
- ローカル詳細確認は script 引数で実行件数を増やせるようにする。

## Validation
- npm run check
- npm run build
- npm run test
- npm run test:parity -- --seed-count 4 --minutes 1
- cargo test --manifest-path rust/server/Cargo.toml --all-targets
