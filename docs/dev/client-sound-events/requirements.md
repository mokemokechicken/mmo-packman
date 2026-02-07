# Requirements: client-sound-events

## Goal
Issue #36 の完了条件に合わせ、主要イベント音と設定 UI を最小構成で実装し、視覚中心の体験を補強する。

## Functional Requirements
1. 主要イベント（覚醒、制覇、ダウン、ボス出現、ゲーム終了）でサウンドを再生できること。
2. 音量スライダーとミュートを UI から変更でき、設定をローカル保存できること。
3. モバイル制約に対応し、初回ユーザー操作後にのみ再生開始すること。
4. 将来の BGM/SE 差し替えを見据えたアセット配置・命名ルールを docs に明記すること。

## Non-Functional Requirements
- サウンド未解放/無効時でもゲーム進行を阻害しないこと。
- lint/build/test を pass すること。
