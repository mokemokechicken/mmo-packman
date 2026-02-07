# Design: persistent-ranking

## Approach
1. `RankingStore` を追加し、`GameSummary.ranking` を名前キーで集計して JSON ファイルへ永続化する。
2. `GET /api/ranking` を追加し、上位N件（既定10件）を返す。
3. 集計値は `matches`, `wins`, `winRate`, `avgCaptureRatio`, `avgRescues`, `bestScore` を返す。
4. ロビー描画時に `/api/ranking` をフェッチし、上位ランキングを表示する。
5. ファイルI/O失敗時は warn ログに落とし、空ランキングで継続する。

## Validation
- `npm run check`
- `npm run build`
- `npm run test`
