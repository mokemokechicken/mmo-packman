# Requirements: balance-checklist-12-3

## Goal
`docs/game_design.md` 12.3 の未チェック項目を検証し、各項目に `OK/NG/保留` 判定を付与する。

## Functional Requirements
1. AI x2 / x5 / 大人数（80人以上）シナリオを複数seedで実行し、主要指標を集計する。
2. 12.3 の各項目に対して判定と根拠を記録する。
3. `NG` 判定の項目は個別改善Issueへ分割する。
4. 定期観測向けに検証手順としきい値を `docs/ai_test_play.md` または `docs/operation_notes.md` に追記する。

## Non-Functional Requirements
- 検証は再現可能なコマンドとseedを明記する。
- 主観評価（UI/体験）は `保留` とし、必要な追加検証条件を明示する。

## Out of Scope
- バランス調整そのものの実装
- AOI / ルームID / リプレイなど他Issueの機能追加
