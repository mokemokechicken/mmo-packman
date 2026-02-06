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

## 注意

- クライアントとサーバーを同時起動する場合は別ターミナルで起動する。
