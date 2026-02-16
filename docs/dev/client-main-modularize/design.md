# Design: client-main-modularize

## Approach
1. `src/client/replay_model.ts` を新規追加し、`normalizeSummary` / `normalizeSnapshot` / `cloneWorld` / `cloneSnapshot` を集約する。
2. `main.ts` と `replay_parser.ts` は上記モジュールを import するだけに変更し、重複実装を削除する。
3. 既存の `replay_parser.selftest` と全体 test/build/check で回帰確認する。

## Validation
- `npm run check`
- `npm run build`
- `npm run test`
