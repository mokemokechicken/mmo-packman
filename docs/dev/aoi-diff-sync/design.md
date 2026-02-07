# Design: aoi-diff-sync

## Approach
1. `aoi.ts` を新設し、viewerごとの `Snapshot` フィルタリング（players/ghosts/fruits/events）を実装する。
2. サーバー送信時に room 内クライアントごとに `buildAoiSnapshot(...)` を適用し、観戦者はフル配信にする。
3. protocol は `state.snapshot` をそのまま使い、payload の中身だけを viewer 単位に最適化する。
4. `AOI_ENABLED` と `AOI_RADIUS_TILES` で運用切替可能にする。
5. `aoi.selftest` と `aoi_metrics` 実行で、削減率とCPUコストを可視化する。

## Validation
- `npm run check`
- `npm run build`
- `npm run test`
