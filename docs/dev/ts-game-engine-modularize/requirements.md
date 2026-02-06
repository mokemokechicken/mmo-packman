# Requirements: ts-game-engine-modularize

## Goal
`src/server/game.ts` の責務分離を進め、仕様修正時の影響範囲を小さくする。

## Functional Requirements
1. ゲームロジックの共通判定/ユーティリティを独立モジュールへ切り出す。
2. ゲート関連ロジックを専用モジュール化する。
3. 既存挙動を維持したまま `GameEngine` の見通しを改善する。
4. 回帰防止のselftestを追加する。

## Non-Functional Requirements
- 既存プロトコル互換を維持する。
- `npm run check/build/test` が通ること。
