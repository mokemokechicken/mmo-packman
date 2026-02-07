# Design: classic-wall-outline

## Approach
1. 壁セルの背景は最小限に留め、壁本体は `CanvasRenderingContext2D` の stroke 描画で構成する。
2. 各壁セルについて exposed edge（隣接が非壁の辺）を判定し、辺ごとの線分を描く。
3. exposed edge が直交接続する角には quarter arc を描いて角丸接続を作る。
4. 線太さ・角丸半径は `tileSize` に対する比率で算出し、ズーム時も崩れないようにする。
5. 壁色は discovered 状態を優先しつつ、captured / dark セクターの色意図に沿ったトーンで描画する。

## Validation
- `npm run check`
- `npm run build`
- `npm run test`
