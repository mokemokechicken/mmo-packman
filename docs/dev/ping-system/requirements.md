# Requirements: ping-system

## Goal
Issue #33 の完了条件を満たすため、プレイヤーが最小ピン（位置 + 種別）を送信し、全クライアントで同期表示できるようにする。

## Functional Requirements
1. クライアントはプレイ中にピン種別（3種）を送信でき、サーバーが投稿者の現在位置に設置できること。
2. サーバーは有効期限（TTL）付きでピンを管理し、`state.snapshot` に含めて全クライアントへ同期すること。
3. 同時表示上限・プレイヤーごとのレート制御を実装し、スパム投稿を抑制すること。
4. 観戦者のピン権限は「投稿不可、閲覧のみ」とし、プロトコル/実装で明示すること。

## Non-Functional Requirements
- 既存のゲーム進行・再接続・観戦表示を壊さないこと。
- `npm run check` / `npm run build` / `npm run test` を pass すること。
