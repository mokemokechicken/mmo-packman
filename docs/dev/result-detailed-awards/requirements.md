# Requirements: result-detailed-awards

## Goal
Issue #34 の完了条件に合わせ、試合サマリから主要行動メトリクスを表彰として可視化し、リザルト体験を向上する。

## Functional Requirements
1. `game_over.summary` に表彰情報を含め、少なくとも `救助王 / 探索王 / 防衛王` を算出できること。
2. 表彰は試合中に集計済みメトリクス（`rescues`, `dots`, `captures` など）から決定し、同率受賞に対応すること。
3. クライアントのリザルト画面に表彰セクションを追加し、受賞カテゴリ・受賞者・値を表示できること。
4. 表彰データ構造を `docs/server_protocol.md` に追記し、クライアント/サーバー間契約を明文化すること。

## Non-Functional Requirements
- 既存ランキング表示と互換性を維持し、既存メッセージ型を破壊しないこと。
- lint/build/test を pass すること。
