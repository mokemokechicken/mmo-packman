# システム設計

## 全体構成（dual-backend）

- Client: TypeScript + Vite + Canvas
- Server (TypeScript): `src/server/`（現在の標準実装）
- Server (Rust): `rust/server/`（導入時にTS実装と仕様互換を目指す）
- 通信: JSON over WebSocket

```text
Browser Client (Player / Spectator)
  -> WebSocket (/ws)
TypeScript Server (authoritative, current default)
  - Lobby / Match lifecycle
  - 20Hz game loop
  - Map / Player / Ghost simulation

Rust Server (compatibility target)
  - Same game contract / simulation semantics
```

## Authoritative Path（2026-02-07 時点）

- 標準運用は TypeScript サーバー (`src/server/`)。
- クライアントが参照するプロトコルの正は `src/shared/types.ts`。
- Rust 側を使う場合も、プロトコルと主要ゲーム挙動をTS側へ合わせる。

## ディレクトリ構成

- `src/shared/` 共通型・定数（クライアントとTSサーバーの契約）
- `src/server/` TypeScript サーバー実装
- `src/client/` クライアント実装
- `rust/server/` Rust サーバー実装（存在する場合）
- `docs/` ドキュメント

## サーバー責務（TS/Rust共通）

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

## ティック処理順（互換対象）

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

## パリティ方針（TS/Rust）

- プロトコル互換: `snapshot/events/summary` のJSON構造は互換を維持する。
- ルール互換: ゲート通行、capture/regen、respawn、終了条件など主要仕様は一致させる。
- 検証互換: 同条件シミュレーションで異常検知（NaN, 範囲外値, 不整合）が出ないことを最優先にする。

## データ方針

- サーバーが唯一の正とする（authoritative）。
- クライアントは描画専用キャッシュを保持。
- ドット/パワーエサは `game_init + event delta` で反映。

## テスト/シミュレーション方針

- TypeScript: `npm run check`, `npm run build`, `npm run simulate`
- Rust実装がある場合: `cargo fmt/clippy/test` と `simulate:rust`、`test:parity` を追加で実行
- CIは上記を自動実行し、再現性確保のため simulate / parity は固定seedを利用する。
- parity は当面 non-blocking で回し、差分レポートをartifactとして収集する。
