# Requirements: balance-small-party-boss-path

## Goal
Issue #44 の完了条件に合わせ、少人数シナリオでもボス遭遇〜撃破の検証データを取得できるようにする。

## Functional Requirements
1. 少人数（AI x2 / AI x5）でボス遭遇が観測できるパラメータを導入すること。
2. 覚醒ストック3回前提でボスへのヒット（`bossHits`）が発生すること。
3. 代表seed群で `bossSpawned` / `bossHits` を取得し、検証可能な状態にすること。
4. 12.3 判定に使うボス関連メトリクスを `docs/ai_test_play.md` に追記すること。

## Non-Functional Requirements
- 既存の終盤圧（大人数向け）を極端に崩さないこと。
- Rust/TypeScript の lint/build/test を通すこと。
