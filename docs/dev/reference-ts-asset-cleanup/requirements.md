# Requirements: reference-ts-asset-cleanup

## Goal
Issue #68 の完了条件として、現行運用（Rust server + client）と参考実装（退避 TS server）の依存・設定境界を明確化し、ルート package の責務を最小化する。

## Functional Requirements
1. ルート `package.json` から、現行運用で不要な参考 TS server 用依存（`express`, `ws`, `@types/express`, `@types/ws`）を除去すること。
2. 参考 TS server を起動したい場合の依存解決手順を、`reference/ts-server` 側に明示すること。
3. 使われていない `tsconfig.server.json` を整理し、現行運用に紐づく設定のみを残すこと。
4. 既存の parity / selftest / build フローは維持すること。

## Non-Functional Requirements
- `npm run check` / `npm run build` / `npm run test` が pass すること。
- 既存の Rust 実行フロー（`npm run start`, `npm run simulate`）に影響を与えないこと。
