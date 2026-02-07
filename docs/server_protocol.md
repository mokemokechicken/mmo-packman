# サーバー/クライアント通信プロトコル

## Transport

- WebSocket endpoint: `/ws`
- 形式: JSON

## HTTP API

- `GET /api/ranking?limit=10`
  - 永続ランキング取得
  - response: `{ generatedAtIso, entries[] }`
  - `entries[]` は `name, matches, wins, winRate, avgCaptureRatio, avgRescues, bestScore, updatedAtMs`

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
- `place_ping`
  - `kind`: `focus | danger | help`
  - 座標はサーバーが投稿者の現在位置を採用する
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
  - `seed`（リプレイ再現用）
  - `isSpectator`
- `state`
  - 20Hz スナップショット
  - プレイヤー / ゴースト / フルーツ / セクター / ゲート
  - `pings`（TTL付きピン一覧）
  - 差分イベント（ドット消化、ダウン、救出など）
- `game_over`
  - 勝敗理由
  - ランキング
  - 表彰（`summary.awards`）
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
- 観戦者は `place_ping` 不可（閲覧のみ）。サーバー側で拒否する。

## `game_over.summary.awards` の形式

```json
{
  "awards": [
    {
      "id": "rescue_king",
      "title": "救助王",
      "metricLabel": "救助数",
      "value": 7,
      "winners": [
        {
          "playerId": "p1",
          "name": "P1"
        }
      ]
    }
  ]
}
```

- `id`: `rescue_king | explorer_king | defense_king | ghost_hunter`
- `metricLabel`: UI 表示向けの指標名
- `value`: 指標の受賞値（同率受賞時は共通）
- `winners`: 同率を含む受賞者一覧
- `awards` は常に配列として送信される（該当なしの場合は `[]`）
- すべて 0 件のカテゴリは送信対象外（`awards` から除外）
