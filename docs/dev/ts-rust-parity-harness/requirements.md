# Requirements: ts-rust-parity-harness

## Goal
TypeScript サーバー実装と Rust サーバー実装の主要シミュレーション結果のパリティを、自動テストで継続検証できる状態にする。

## Functional Requirements
1. 複数seed（デフォルト10本以上）で TS/Rust のシミュレーションを同条件実行できること。
2. 比較対象メトリクスを定義し、差分を検知できること。
3. 完全一致が難しい値は許容誤差付きで比較できること。
4. 失敗時に seed / シナリオ / 差分内容が再現可能な形で出力されること。
5. CI で定期的に実行されること。

## Comparison Scope
- 終了理由 (`reason`)
- 異常件数 (`anomalies.length`)
- イベント集計 (`dotEaten`, `dotRespawned`, `downs`, `rescues`, `sectorCaptured`, `sectorLost`, `bossSpawned`, `bossHits`)
- capture 指標 (`maxCapture`, `minCaptureAfter70`) は誤差許容付き比較

## Non-Functional Requirements
- 既存シミュレーター出力仕様（1行JSON）を活用し、新規ハーネスは追加実装に留める。
- ローカル実行時間は過大にならないよう、既定は軽量プロファイルにする。
