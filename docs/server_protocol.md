# サーバー/クライアント通信プロトコル

## Transport

- WebSocket endpoint: `/ws`
- 形式: JSON

## Client -> Server

- `hello`
  - `name`: 表示名
  - `reconnectToken?`: 再接続トークン
  - `spectator?`: `true` で観戦参加
- `lobby_start`
  - `difficulty?`: `casual | normal | hard | nightmare`
  - `aiPlayerCount?`: AIプレイヤー人数
  - `timeLimitMinutes?`: テスト時間（1〜10分）
- `input`
  - `dir?`: `up/down/left/right`
  - `awaken?`: `true` で覚醒発動要求
- `ping`
  - `t`: 任意の数値

## Server -> Client

- `welcome`
  - `playerId`
  - `reconnectToken`
  - `isHost`
  - `isSpectator`
- `lobby`
  - メンバー一覧（`spectator` フラグ付き）
  - `hostId`
  - `canStart`
  - `running`
  - `spectatorCount`
- `game_init`
  - ワールド初期情報（壁、ドット、パワーエサ、セクター、ゲート）
  - ゲーム設定
  - `isSpectator`
- `state`
  - 20Hz スナップショット
  - プレイヤー / ゴースト / フルーツ / セクター / ゲート
  - 差分イベント（ドット消化、ダウン、救出など）
- `game_over`
  - 勝敗理由
  - ランキング
  - タイムライン
- `error`
  - エラーメッセージ
- `pong`
  - ping応答

## 再接続仕様

- クライアントは `welcome.reconnectToken` を保存
- 切断後に `hello` で同トークンを送ると同一メンバーに復帰
- 試合中の新規プレイヤー参加は不可（観戦参加は可）

## 注意点

- 現在はMVPのためメッセージ署名・暗号化は未実装
- 本番化時は認証とレート制限を追加する

## 互換テスト

- Rust 側の最小プロトコル互換テストは `rust/server/src/bin/server.rs` の unit test で実施する。
