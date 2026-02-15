# Design: reference-ts-asset-cleanup

## Approach
1. ルート依存を「現役コード実行に必要なもの」に限定する。
2. 退避 TS server の実行依存は `reference/ts-server/package.json` に分離する。
3. 退避 TS server の利用方法を `docs/ts_server_archive.md` に明記し、通常開発フローと混線しないようにする。
4. 現在参照されていない `tsconfig.server.json` を削除して設定ノイズを減らす。

## Validation
- `npm install`
- `npm run check`
- `npm run build`
- `npm run test`
