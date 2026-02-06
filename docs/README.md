# ドキュメント一覧

このリポジトリは、`docs/game_design.md` をベースにした **MMO Packman プロトタイプ（MVP）** の実装です。

## まず読む

1. [MVP仕様と実装状況](./mvp_scope.md)
2. [ローカル開発ガイド](./local_development.md)
3. [システム設計](./architecture.md)

## 実装詳細

- [サーバー/クライアント通信プロトコル](./server_protocol.md)
- [AI-only テストプレイ手順](./ai_test_play.md)
- [Cloud Run デプロイ手順](./deployment_cloud_run.md)
- [運用メモ / バランス調整観点](./operation_notes.md)

## 運用方針（重要）

- [システム設計](./architecture.md)
  - TypeScript / Rust の dual-backend 前提
  - 現時点の authoritative path
  - パリティ方針（互換レベル）
  - テスト / simulate 実行方針

## 元のゲームデザイン

- [ゲームデザイン](./game_design.md)
