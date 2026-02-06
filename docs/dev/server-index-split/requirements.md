# Requirements: server-index-split

## 背景

- `src/server/index.ts` に接続管理・メッセージ検証・ロビー制御が集中しており、変更影響が広い。

## 要求

1. `ClientMessage` の runtime validation を `index.ts` から分離する。
2. クライアント接続/バインド管理（clients, active mapping, supersede処理）を `index.ts` から分離する。
3. 既存挙動（再接続、stale close 無視、broadcast対象制御）を維持する。
4. `check/build/test` が通ること。

## 非要求

- ルーム分割や認証導入は対象外。
- ロビー仕様自体の変更は行わない。
