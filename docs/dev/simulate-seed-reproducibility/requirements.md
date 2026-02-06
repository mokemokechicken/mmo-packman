# Requirements: simulate-seed-reproducibility

## 背景

- `src/server/simulate.ts` は内部 seed に `Date.now()` を使っているため、同条件での再現実行が難しい。
- 異常値やバランス崩れを再検証したい時に、同じ条件を完全再現したい。

## 要求

1. `npm run simulate -- --seed <number>` を受け付けること。
2. seed 未指定時も、実行に使った seed を結果に出力すること。
3. デフォルト2シナリオ実行時は、各シナリオに使った seed が明示されること。
4. 手順書 (`docs/ai_test_play.md`) に seed を使った再現方法を追記すること。

## 非要求

- シミュレーションロジックのゲームバランス調整はこの対応対象外。
- `npm run simulate` の既存引数 (`--single --ai --minutes --difficulty`) の仕様変更はしない。
