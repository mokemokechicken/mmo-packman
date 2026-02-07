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
- 現在このコマンドでサーバーは起動しない（TSサーバーは退避済み）。

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

## 注意

- Rust WebSocket サーバーは未実装のため、UI からの実プレイは現時点では未対応。
- 追跡Issue: [#27](https://github.com/mokemokechicken/mmo-packman/issues/27)
