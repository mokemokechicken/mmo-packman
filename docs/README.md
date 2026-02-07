# ドキュメント一覧

このリポジトリは、`docs/game_design.md` をベースにした **MMO Packman プロトタイプ（MVP）** の実装です。

## まず読む

1. [MVP仕様と実装状況](./mvp_scope.md)
2. [ローカル開発ガイド](./local_development.md)
3. [システム設計](./architecture.md)

## 実装詳細

- [サーバー/クライアント通信プロトコル](./server_protocol.md)
- [AI-only テストプレイ手順](./ai_test_play.md)
- [タイムラプスリプレイ手順](./replay_timelapse.md)
- [AOI差分同期メトリクス](./aoi_metrics.md)
- [Rust サーバー再実装メモ](./rust_server_reimplementation.md)
- [TypeScript サーバー参考実装の退避メモ](./ts_server_archive.md)
- [Cloud Run デプロイ手順](./deployment_cloud_run.md)
- [運用メモ / バランス調整観点](./operation_notes.md)

## 運用方針（重要）

- [システム設計](./architecture.md)
  - Rust サーバー開発を主軸にする前提
  - 現時点の authoritative path
  - テスト / simulate 実行方針

## 元のゲームデザイン

- [ゲームデザイン](./game_design.md)
