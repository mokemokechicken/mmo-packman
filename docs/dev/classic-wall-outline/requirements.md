# Requirements: classic-wall-outline

## Goal
Issue #61 の完了条件に合わせ、壁タイル描画を全面塗りつぶしから薄い角丸ライン表現へ変更する。

## Functional Requirements
1. 壁タイル（`#`）は線ベースの描画に変更し、通路が現状より広く見えること。
2. 壁接続（上下左右）に応じてライン接続を行い、角の見た目を丸めること。
3. 壁の当たり判定・移動ロジック・マップデータ形式には一切変更を入れないこと。
4. discovered / captured / dark の視覚意図を維持し、未探索・探索済みの判別を保つこと。

## Non-Functional Requirements
- 画面サイズやズーム変更時に壁線太さが `tileSize` 比率で追従すること。
- `npm run check` / `npm run build` / `npm run test` を pass すること。
