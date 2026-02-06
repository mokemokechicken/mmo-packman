# サーバー/クライアント通信プロトコル

## Transport

- WebSocket endpoint: `/ws`
- 形式: JSON

## Client -> Server

- `hello`
  - `name`: 表示名
  - `reconnectToken?`: 再接続トークン
- `lobby_start`
  - `difficulty?`: `casual | normal | hard | nightmare`
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
- `lobby`
  - プレイヤー一覧
  - `hostId`
  - `running`
- `game_init`
  - ワールド初期情報（壁、ドット、パワーエサ、セクター、ゲート）
  - ゲーム設定
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
- 切断後に `hello` で同トークンを送ると同一プレイヤーに復帰
- ゲーム進行中にトークン無しの新規参加は拒否

## 注意点

- 現在はMVPのためメッセージ署名・暗号化は未実装
- 本番化時は認証とレート制限を追加する
