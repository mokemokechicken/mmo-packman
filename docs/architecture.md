# システム設計

## 全体構成

- Client: TypeScript + Vite + Canvas
- Server: Node.js (TypeScript), Express, ws
- 通信: JSON over WebSocket

```text
Browser Client (Player / Spectator)
  -> WebSocket (/ws)
Game Server (authoritative)
  - Lobby / Match lifecycle
  - 20Hz game loop
  - Map / Player / Ghost simulation
```

## ディレクトリ構成

- `src/shared/` 共通型・定数
- `src/server/` サーバー実装
- `src/client/` クライアント実装
- `docs/` ドキュメント

## サーバー責務

- ロビー管理（ホスト、開始、再接続、観戦）
- AI-only試合の組成（AI人数指定）
- プレイヤー入力適用
- 物理更新（タイル移動）
- 衝突判定
- エリア制覇・劣化
- ゴーストAI
- プレイヤーAI（救助・探索・防衛・逃走）
- 勝敗判定
- スナップショット配信

## クライアント責務

- 入力送信（方向、覚醒）
- 観戦参加送信
- スナップショット描画
- イベント適用（ドット消失/再生成など）
- HUD / ロビー / リザルト表示
- 観戦カメラ（追従対象切替）

## ティック処理順

ループ制御:

- `setInterval` はトリガーとして使い、`performance.now()` + accumulator で fixed-step (`TICK_MS`) を実行
- 遅延時は1ループ内で複数stepを消化し、実時間追従する
- 1ループあたりの最大stepを制限して過負荷連鎖を防止する
- step上限到達で backlog が残る場合は tick 境界まで圧縮し、安定性を優先する

1. ゲート更新
2. パワーエサ再出現判定
3. フルーツスポーン
4. プレイヤー更新
5. ゴースト更新
6. 衝突解決
7. 制覇/劣化更新
8. ゴースト数調整
9. マイルストーン記録
10. 勝敗判定

## データ方針

- サーバーが唯一の正とする（authoritative）
- クライアントは描画専用キャッシュを保持
- ドット/パワーエサは `game_init + event delta` で反映

## 拡張しやすさのポイント

- `src/shared/types.ts` にプロトコルを集約
- `GameEngine` にゲームルールを集約
- ワールド生成は `world.ts` として分離
- AI-only検証は `src/server/simulate.ts` で独立実行
