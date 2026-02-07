# Requirements: persistent-ranking

## Goal
Issue #35 の完了条件に合わせ、試合結果を永続化し、ランキング取得APIとクライアント閲覧UIを提供する。

## Functional Requirements
1. 試合終了時のサマリーを永続ストレージへ追記し、再起動後も戦績が残ること。
2. 勝率・平均制覇率・平均救助数・最高スコアを集計したランキングAPIを提供すること。
3. クライアント（ロビー画面）でランキングを閲覧できること。
4. AIアカウントはランキング対象外とし、人間プレイヤー名ベースで集計すること。

## Non-Functional Requirements
- ストレージファイル欠損/破損時にサーバーがクラッシュしないこと。
- `npm run check` / `npm run build` / `npm run test` を pass すること。
