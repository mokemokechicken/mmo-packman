# ローカル開発ガイド

## 必要環境

- Node.js 20+
- npm
- Rust toolchain（`cargo`）

## セットアップ

```bash
npm install
```

## クライアント開発起動

```bash
npm run dev
```

- クライアント(Vite): `http://localhost:5173`
- このコマンドではサーバーは起動しない。別途 `npm run start:rust-server` を起動する。

## Rust WebSocket サーバー起動

```bash
npm run start:rust-server
```

- WebSocket endpoint: `ws://localhost:8080/ws`
- health check: `http://localhost:8080/healthz`

## ビルド

```bash
npm run build
```

生成物:

- `dist/client/`

## 型チェック

```bash
npm run check
```

## Node側テスト

```bash
npm run test
```

## Rust テスト

```bash
cargo fmt --manifest-path rust/server/Cargo.toml --all --check
cargo clippy --manifest-path rust/server/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path rust/server/Cargo.toml --all-targets
```

## AI-onlyテストプレイ（CLI）

```bash
npm run simulate
```

カスタム実行例:

```bash
npm run simulate -- --single --ai 5 --minutes 10 --difficulty normal
```

## 参考: 退避した TypeScript 実装を実行

```bash
npm run reference:ts:simulate -- --single --ai 5 --minutes 3 --difficulty normal
```

## タイムラプスリプレイ

- 生成/再生手順とフォーマット: [docs/replay_timelapse.md](./replay_timelapse.md)

## 複数ルーム検証

1. ロビーの `ルームID` に `room-a` / `room-b` など別値を入力して保存する。
2. 別タブを開き、異なる `ルームID` を設定して接続する。
3. それぞれのルームで開始し、進行が相互干渉しないことを確認する。

## AOI差分同期検証

- メトリクス計測: `npm run measure:aoi`
- AOI無効化（従来配信）: `AOI_ENABLED=0` でサーバー起動
- 半径調整: `AOI_RADIUS_TILES=<number>`

## 注意

- クライアントとサーバーを同時起動する場合は別ターミナルで起動する。
