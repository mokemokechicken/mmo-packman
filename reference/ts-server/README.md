# TypeScript Server Reference Archive

このディレクトリは、旧 `src/server/` の退避先です。

- 開発対象: **外**
- 目的: Rust 実装への移植時に挙動や実装方針を参照するため
- 実行依存は `reference/ts-server/package.json` で管理（ルート package とは分離）
- 実行例:

```bash
npm run reference:ts:simulate -- --single --ai 5 --minutes 3 --difficulty normal
```

`src/server/index.ts` を単体で動かす場合:

```bash
npm ci --prefix reference/ts-server
npm --prefix reference/ts-server run start
```
