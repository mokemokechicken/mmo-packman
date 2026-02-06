# Requirements: balance-ai-substitution-resilience

## Goal
Issue #45 の完了条件に合わせ、少人数（AI x2 / casual）での全滅率を下げ、離脱時AI代行が継続プレイを維持できる状態にする。

## Functional Requirements
1. AI代行は「即時危険回避（自己保全）」を最優先し、その次にダウン中プレイヤー救助を優先すること。
2. AI代行が危険セルへの突入を避け、覚醒ストックを防御的に使えること。
3. AI x2 / casual（seed 1001-1010, 10分）で `all_down_rate <= 20%` を満たすこと。
4. 観測指標（all_down率、救助傾向）を `docs/operation_notes.md` に記録すること。
5. 同シナリオで `avgMaxCapture >= 5.0%` を維持し、進行停滞の退行を防ぐこと。

## Non-Functional Requirements
- Rustテスト、TypeScriptチェック、ビルドが通ること。
- 既存のAI挙動（ドット回収・パワー中追跡）を破壊しないこと。
