# TS/Rust Parity Harness

## 目的
TypeScript 参考実装 (`reference/ts-server/src/server/simulate.ts`) と Rust 実装 (`rust/server/src/bin/simulate.rs`) の主要メトリクス差分を継続監視する。

## 比較項目
- 完全一致（必須）
  - `reason`
  - `dotRespawned`
  - `sectorLost`
  - `bossSpawned`
  - `bossHits`
- 許容差分（現時点）
  - `dotEaten`
  - `downs`
  - `rescues`
  - `sectorCaptured`
  - `maxCapture`
  - `minCaptureAfter70`

## 許容差分ルール
- 現行 Rust 実装は TS 参考実装と AI判断/進行速度設計が意図的に分岐しているため、上記6項目は parity fail 条件から除外する。
- それ以外の項目差分は不許容（即失敗）。
- 許容差分を縮小する場合は、`reference/ts-server/src/server/parity_harness.ts` の `compareResults` を更新し、CI と同時に tightening する。

## 実行コマンド
- ローカル（CI同等の軽量設定）
  - `npm run test:parity -- --ai 5 --minutes 1 --difficulty normal --seed-start 1001 --seed-count 4`
- 代表seed群の確認例
  - `npm run test:parity -- --ai 5 --minutes 1 --difficulty normal --seed-start 1101 --seed-count 20`

## 現在の観測
- 2026-02-07: `ai=5`, `minutes=1`, `difficulty=normal`, `seed=1101..1120`（20 seeds）で差分 0 件。

## CI 運用
- `.github/workflows/ci.yml` で parity を blocking 実行する。
- parity 失敗時は CI 全体を失敗とし、merge を停止する。
