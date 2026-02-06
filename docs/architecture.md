# システム設計

## 全体構成（Rustサーバー主軸）

- Client: TypeScript + Vite + Canvas
- Server (Rust): `rust/server/`（今後の開発対象）
- 参考実装 (TypeScript): `reference/ts-server/src/server/`（開発停止）
- 通信: JSON over WebSocket（Rust側で実装予定）

```text
Browser Client (Player / Spectator)
  -> WebSocket (/ws)
Rust Server (authoritative target)
  - Lobby / Match lifecycle
  - 20Hz game loop
  - Map / Player / Ghost simulation

TypeScript Server (reference only, archived)
  - Implementation reference for migration
```

## Authoritative Path（2026-02-07 時点）

- 標準運用・今後の実装先は Rust サーバー (`rust/server/`)。
- TypeScript サーバーは `reference/ts-server/src/server/` に退避し、参考実装としてのみ扱う。
- クライアント契約の正は `src/shared/types.ts`。

## ディレクトリ構成

- `src/client/` クライアント実装
- `src/shared/` 共通型・定数
- `rust/server/` Rust サーバー実装（開発対象）
- `reference/ts-server/src/server/` TypeScript サーバー参考実装（開発停止）
- `docs/` ドキュメント

## サーバー責務（Rust）

- ロビー管理（ホスト、開始、再接続、観戦）
- AI-only試合の組成（AI人数指定）
- プレイヤー入力適用
- 物理更新（タイル移動）
- 衝突判定
- エリア制覇・劣化
- ゴーストAI / プレイヤーAI
- 勝敗判定
- スナップショット配信

## データ方針

- サーバーが唯一の正（authoritative）。
- クライアントは描画専用キャッシュを保持。
- ドット/パワーエサは `game_init + event delta` で反映。

## 現在の実装状態

- Rust 側は現在 simulator / ゲームコアを実装済み。
- Rust WebSocket サーバーは未実装（Issue [#27](https://github.com/mokemokechicken/mmo-packman/issues/27)）。

## テスト / シミュレーション方針

- Node側: `npm run check`, `npm run build`, `npm run test`
- Rust側: `cargo fmt --manifest-path rust/server/Cargo.toml --all --check`, `cargo clippy --manifest-path rust/server/Cargo.toml --all-targets -- -D warnings`, `cargo test --manifest-path rust/server/Cargo.toml --all-targets`
- シミュレーション: `npm run simulate -- --single --ai 5 --minutes 10 --difficulty normal`
- 参考TS実装を比較したい場合のみ: `npm run reference:ts:simulate -- --single --ai 5 --minutes 10 --difficulty normal`
