# Design: server-index-split

## 方針

- `index.ts` をオーケストレーション寄りにし、以下を専用モジュールへ抽出する。
  - `message_parser.ts`: `ClientMessage` runtime validation
  - `session_manager.ts`: client生成/破棄、playerバインド、active client判定

## 分離対象

1. `parseMessage` + 補助型ガード
2. `clients` / `activeClientByPlayerId` の管理関数
   - bind時の supersede close（`SessionManager` 内で実施）
   - supersede 時の close policy は `4001: superseded by new connection`
   - close時の active/stale 判定
   - playerId から client取得

## index.ts に残す責務

- ロビー状態 (`lobbyPlayers`, `hostId`) の管理
- ゲーム開始/終了と snapshot 配信
- domainルール（canStart, host選出, note構築）

## 影響範囲

- `src/server/index.ts`
- `src/server/message_parser.ts` (新規)
- `src/server/session_manager.ts` (新規)
