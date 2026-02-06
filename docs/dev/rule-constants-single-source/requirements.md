# Requirements: rule-constants-single-source

## Goal
TS/Rustで重複管理されているゲームルール定数を単一ソース化し、仕様ドリフトを防ぐ。

## Functional Requirements
1. ルール定数の原本ファイルを1つ用意する。
2. 原本から `src/shared/constants.ts` と `rust/server/src/constants.rs` を生成できること。
3. 生成コマンドを再実行しても同じ内容が得られること。
4. 原本変更時に更新手順が明確であること。
5. `npm run check` で生成物の未更新を検知できること。
6. 原本JSONの閾値配列順序や型不正を生成前に検知できること。

## Non-Functional Requirements
- 既存関数シグネチャ（`getMapSideByPlayerCount` など）を維持する。
- 既存テスト・シミュレーションが通ること。
