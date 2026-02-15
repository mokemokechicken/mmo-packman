# TypeScript サーバー参考実装の退避メモ

## 背景

- TypeScript サーバー開発は一旦停止し、Rust サーバー実装へ集中する方針に変更した。
- 既存の TypeScript 実装は、仕様比較・移植時の参照のため保持する。

## 退避先

- 旧 `src/server/` は以下に移動済み:
  - `reference/ts-server/src/server/`

## 運用ルール

- `reference/ts-server/src/server/` 配下は**参考実装**として扱い、新規機能開発の対象にしない。
- 今後のサーバー機能追加・不具合修正は `rust/server/` を正とする。
- 参考実装の起動依存は `reference/ts-server/package.json` で管理し、ルート package とは分離する。
- 必要時のみ、以下で参考シミュレーションを実行する:

```bash
npm run reference:ts:simulate -- --single --ai 5 --minutes 3 --difficulty normal
```

参考実装サーバー (`index.ts`) を単体実行したい場合:

```bash
npm ci --prefix reference/ts-server
npm --prefix reference/ts-server run start
```
