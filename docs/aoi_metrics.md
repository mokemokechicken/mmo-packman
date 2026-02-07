# AOI差分同期メトリクス

## 計測条件
- コマンド: `npm run measure:aoi`
- 実装: `reference/ts-server/src/server/aoi_metrics.ts`
- サンプル: 24プレイヤー試合のスナップショット、viewer 6名
- AOI半径: 12タイル（Manhattan距離）

## 結果

| 指標 | 値 |
| --- | --- |
| フルスナップショットサイズ | 26,834 bytes |
| AOI適用平均サイズ | 19,323 bytes |
| 配信量削減率 | 28.0% |
| AOIフィルタCPU（1 snapshot/viewer あたり） | 0.0087 ms |

## 解釈
- 非観戦クライアントに対して、entity payload（players/ghosts/fruits/pings/events）をAOIで絞ることで、
  1 viewer あたり約 28% の配信量削減が確認できた。
- フィルタ計算コストは 0.01ms 未満/件で、20Hz配信でも支配的なCPU要因にはなりにくい。
- 観戦クライアントは全体把握を優先し、フル配信を維持する。
