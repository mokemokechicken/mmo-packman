# Requirements: balance-large-scenario-endgame

## Goal
Issue #43 の完了条件に合わせ、80〜100人帯シナリオで終盤（70%以上）到達を継続観測できるようにする。

## Functional Requirements
1. 大人数シナリオ（AI x80 / normal）で最大制覇率70%以上到達を観測できること。
2. 80〜100人帯の敵圧/維持コスト/制圧速度を調整し、終盤到達率を改善すること。
3. 代表seed群の結果を `docs/operation_notes.md` に記録すること。
4. 80〜100人帯のみ、セクター掌握判定を緩和（残ドット35%以下で掌握）して進行テンポを改善すること。
5. 79人以下の挙動は既存ルールを維持すること。

## Non-Functional Requirements
- 少人数向けの既存調整（#44/#45）を大きく破壊しないこと。
- lint/build/test を通すこと。
- 掌握ベースの勝利判定とタイムライン文言を整合させること。
