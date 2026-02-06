# Design: simulate-seed-reproducibility

## 方針

- 既存 CLI 解析に `--seed` を追加する。
- `Scenario` に `seed` を持たせ、`GameEngine` 初期化時にその値を渡す。
- 出力 JSON に `seed` を追加し、再実行しやすくする。

## 仕様

1. `--seed` 指定時
   - `--single` の場合: その seed を使う。
   - デフォルト2シナリオの場合: 1件目に base seed、2件目に base seed + 1 を使う。
2. `--seed` 未指定時
   - `Date.now()` を base seed として採用する。
   - 実際に使った seed は結果 JSON に必ず含める。
3. `--seed` の入力検証
   - `--seed` 指定時に値が欠落/非数値ならエラー終了する。
4. seed 正規化
   - 実際に使う seed は `uint32` (`0..4294967295`) に正規化する。

## 影響範囲

- `src/server/simulate.ts`
  - `Scenario`/`ScenarioResult` に `seed` 追加
  - 引数解析 (`--seed`) 追加
  - 出力 JSON へ `seed` 追加
- `docs/ai_test_play.md`
  - seed 指定による再現実行手順を追記
