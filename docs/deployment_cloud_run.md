# Cloud Run デプロイ手順（現状）

## 状況

- TypeScript サーバーは開発停止し、`reference/ts-server/src/server/` へ退避済み。
- Rust サーバーは現在 simulator / ゲームコア実装までで、WebSocket サーバー本体は未実装。
- そのため、**現時点では Cloud Run への実プレイ用デプロイ手順は未確立**。

## 現時点で実行可能なこと

- Rust シミュレーターによるバランス/異常検証

```bash
npm run simulate -- --single --ai 10 --minutes 10 --difficulty normal
```

## 今後の対応

1. Rust WebSocket サーバー実装（Issue [#27](https://github.com/mokemokechicken/mmo-packman/issues/27)）
2. Cloud Run 向けコンテナの再設計
3. 本ドキュメントへ本番手順を再記載
