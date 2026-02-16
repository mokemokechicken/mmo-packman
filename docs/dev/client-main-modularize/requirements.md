# Requirements: client-main-modularize

## Goal
Issue #66 の完了条件として、`src/client/main.ts` の責務を分離し、`replay_parser.ts` と重複するロジックを共通化する。

## Functional Requirements
1. `main.ts` と `replay_parser.ts` に重複する replay 用 clone/normalize ロジックを共通モジュールへ統合すること。
2. `main.ts` から replay データ変換責務を切り出し、呼び出し側を薄くすること。
3. 既存の replay import/export と再生挙動を維持すること。

## Non-Functional Requirements
- `npm run check` / `npm run build` / `npm run test` を pass する。
