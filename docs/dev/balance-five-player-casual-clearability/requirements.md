# Requirements: balance-five-player-casual-clearability

## Goal
Issue #42 の完了条件に合わせ、5人カジュアルの代表seed群でクリア到達（victory）を観測できるようにする。

## Functional Requirements
1. `AI x5 / casual / 10分 / seed 4001-4005` の代表seed群で、少なくとも1件以上 `reason == victory` を観測できること。
2. 5人カジュアル向けに終盤進行（維持コスト・敵圧・救助導線）を改善すること。
3. 調整根拠と代表seed群の結果を `docs/operation_notes.md` に記録すること。

## Non-Functional Requirements
- 2人カジュアル（issue #45）など既存の少人数調整を破壊しないこと。
- lint/build/test を通すこと。
