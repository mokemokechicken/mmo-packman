# Rust サーバー再実装メモ

## 目的

- サーバーコア（ゲーム進行・AI更新・シミュレータ）を Rust で再実装する。
- 短時間の負荷検証やバランス検証を Rust バイナリで実行できるようにする。
- TypeScript サーバーを参考実装化し、Rust への移行を進める。

## 追加構成

- `rust/server/Cargo.toml`
- `rust/server/src/lib.rs`
- `rust/server/src/constants.rs`
- `rust/server/src/types.rs`
- `rust/server/src/rng.rs`
- `rust/server/src/world.rs`
- `rust/server/src/engine/mod.rs`
- `rust/server/src/engine/sector_system.rs`
- `rust/server/src/engine/spawn_system.rs`
- `rust/server/src/engine/utils.rs`
- `rust/server/src/bin/simulate.rs`
- `rust/server/src/bin/server.rs`

## 実装範囲

- ワールド生成
  - セクター生成
  - ゲート生成
  - ドット/パワーエサ配置
- ゲームエンジン
  - プレイヤーAI移動
  - ゴーストAI移動
  - 衝突処理
  - セクター制圧/劣化
  - ゴースト増減
  - 終了判定
- simulator
  - `--single --ai --minutes --difficulty --seed` の引数対応
  - JSON 1行出力
  - 異常検知 (`anomalies`)
- WebSocket サーバー
  - `/ws`, `/healthz` の提供
  - ロビー/ゲーム進行/再接続/観戦を実装
  - `docs/server_protocol.md` 準拠メッセージ対応

## 実行方法

```bash
cargo run --manifest-path rust/server/Cargo.toml --bin simulate -- --single --ai 10 --minutes 10 --difficulty normal
```

または npm script:

```bash
npm run simulate:rust -- --single --ai 10 --minutes 10 --difficulty normal
```

WebSocket サーバー起動:

```bash
cargo run --manifest-path rust/server/Cargo.toml --bin server
```

または npm script:

```bash
npm run start:rust-server
```

## 既知事項

- TypeScript サーバーは `reference/ts-server/src/server/` に退避済み（参考実装）。
- ルームID複数同時試合、AOI配信、永続ランキングなどは未実装（別Issueで対応）。
