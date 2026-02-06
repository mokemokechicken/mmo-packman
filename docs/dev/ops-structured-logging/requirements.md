# Requirements: ops-structured-logging

## Goal
Rust simulator の実行ログを機械可読で収集できるようにし、異常検知と試合サマリ取得を標準化する。

## Functional Requirements
1. `simulate` 実行時に、試合単位で `matchId/seed/tick` を含む構造化ログを出力できること。
2. 異常検知時に、内容だけでなく発生 tick もログへ記録できること。
3. 試合サマリを JSON 形式で一括取得できること（stdout かファイル出力）。
4. 監視手順（ローカル/Cloud Run 想定）を `docs/operation_notes.md` か `docs/deployment_cloud_run.md` に追記すること。

## Non-Functional Requirements
- 既存の `simulate` 利用フローを壊さず、CI/ローカルで追加依存なしで動くこと。
- ログ1行を JSON object とし、`jq` などの一般的 CLI で集計できること。

## Out of Scope
- 外部APM/監視SaaSとの自動連携
- WebSocket サーバー本体の監視実装
