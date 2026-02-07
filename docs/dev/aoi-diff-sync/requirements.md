# Requirements: aoi-diff-sync

## Goal
Issue #29 の完了条件に合わせ、AOI（Area of Interest）に基づく差分配信を導入し、配信量を削減しつつ既存機能を維持する。

## Functional Requirements
1. 各クライアントへ送る `state.snapshot` を AOI で絞り込み、不要な entity 情報を送らないこと。
2. 観戦クライアントは全体把握が必要なため従来どおりフルスナップショットを受け取れること。
3. 既存 protocol 形式（`state.snapshot`）は維持し、クライアント互換性を壊さないこと。
4. 配信データ量と CPU の比較結果を docs に記録すること。

## Non-Functional Requirements
- AOI 無効化（環境変数）で従来配信へ戻せること。
- `npm run check` / `npm run build` / `npm run test` を pass すること。
