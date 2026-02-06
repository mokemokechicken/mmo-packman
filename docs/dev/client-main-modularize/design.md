# Design: client-main-modularize

## 分割方針

- `main.ts` はアプリ起動とモジュール間接続だけを担当する。
- 各モジュールは以下の責務に限定する。

## モジュール構成

1. `src/client/state.ts`
   - クライアント状態 (`ClientState`) の定義と初期化
   - RuntimeEvent 反映
   - 共通ユーティリティ（ログ・表示ラベル・フォーマット）
2. `src/client/network.ts`
   - WebSocket 接続、再接続、メッセージ parse
   - `ClientMessage` の送信
   - `connect()` の冪等性確保と `disconnect()` 時の再接続抑止
3. `src/client/renderer.ts`
   - Canvas 描画
   - プレイヤー/ゴースト補間状態の更新
   - カメラ中心計算
4. `src/client/ui.ts`
   - Lobby/HUD/Result/Status の DOM 更新
   - キーボード・タッチ入力
   - 観戦ターゲット切替 UI

## main.ts の役割

- DOM 参照の取得
- 各モジュールの初期化
- サーバーメッセージ受信時の状態更新フロー制御
- `requestAnimationFrame` ループ起動

## 互換性

- サーバー通信フォーマットは変更しない。
- UI表示内容と操作キー体系は維持する。

## テスト方針

- 既存 `parseServerMessage` selftest に加え、以下を追加する。
  - `src/client/state.selftest.ts`: event適用と観戦フォーカス解決
  - `src/client/network.selftest.ts`: 再接続制御と `connect()` 冪等性
