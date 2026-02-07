# MMO Packman Prototype

`docs/game_design.md` をベースにした、協力型 MMO Pac-Man の **Playable MVP** です。

## クイックスタート

```bash
npm install
# terminal 1
npm run start
# terminal 2
npm run dev
```

- Rust server start: `npm run start`
- Client preview: `http://localhost:5173`
- Rust WebSocket server: `ws://localhost:8080/ws` (`http://localhost:8080/healthz`)
- Rust simulator: `npm run simulate -- --single --ai 5 --minutes 3 --difficulty normal`

### `npm run start` だけで配信する（静的ファイル + WS）

```bash
npm install
npm run build
npm run start
```

- App: `http://localhost:8080`
- WebSocket: `ws://localhost:8080/ws`

### 静的ファイル配信での確認

```bash
npm run build
# terminal 1
npm run start
# terminal 2
npm run preview
```

> TypeScript サーバーは開発停止し、参照実装として `reference/ts-server/src/server/` に退避しています。  
> 実運用向けサーバーは Rust 実装を使用してください。

## スクリプト

- `npm run dev` クライアント開発サーバー起動（Vite）
- `npm run start` Rust WebSocket サーバー起動
- `npm run start:rust-server` Rust WebSocket サーバー起動
- `npm run check` 型チェック
- `npm run build` 本番ビルド
- `npm run preview` `dist/client` を静的配信して確認
- `npm run test` Node 側の自己テスト
- `npm run test:parity -- --seed-count 4 --minutes 1` TS/Rust parity 比較
- `npm run simulate` Rust 実装の AI-only シミュレーション
- `npm run simulate:rust -- --single --ai 10 --minutes 10 --difficulty normal` Rust実装シミュレータ
- `npm run reference:ts:simulate -- --single --ai 5 --minutes 3 --difficulty normal` 退避したTS参考実装のシミュレータ

## ドキュメント

- [docs/README.md](./docs/README.md)
- [docs/mvp_scope.md](./docs/mvp_scope.md)
- [docs/architecture.md](./docs/architecture.md)
- [docs/local_development.md](./docs/local_development.md)
- [docs/deployment_cloud_run.md](./docs/deployment_cloud_run.md)
