# Design: room-id-multi-match

## Approach
1. `hello.roomId` をプロトコルに追加し、`ClientContext` に紐づける。
2. サーバーに `RoomState` マップを導入し、ロビー状態・ゲーム状態・接続マッピングを room ごとに保持する。
3. `broadcastLobby/state/game_over` を room scoped に変更し、対象 room クライアントのみに送信する。
4. クライアントロビーに `ルームID` 入力を追加し、`localStorage` に保持する。
5. ルームが空になったらサーバー側で idle room を掃除する。

## Validation
- `npm run check`
- `npm run build`
- `npm run test`
