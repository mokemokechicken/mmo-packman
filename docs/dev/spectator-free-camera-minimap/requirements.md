# Requirements: spectator-free-camera-minimap

## Goal
Issue #32 の完了条件に合わせ、観戦モードの視点制御と俯瞰ミニマップを強化し、分析/配信用途の操作性を改善する。

## Functional Requirements
1. 観戦中に自由カメラ（パン/ズーム）を操作できること。
2. 既存の追従モード（プレイヤーフォーカス）と自由カメラを切り替えられること。
3. 俯瞰ミニマップを表示し、ミニマップから対象プレイヤーへフォーカス切替できること。
4. 観戦UI上で現在のカメラモード・ズーム状態を確認できること。

## Non-Functional Requirements
- 既存プレイヤーモード操作（移動/覚醒）を破壊しないこと。
- lint/build/test を pass すること。
