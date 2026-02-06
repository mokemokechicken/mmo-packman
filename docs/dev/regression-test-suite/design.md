# Design: regression-test-suite

## 方針

- 既存運用に合わせ、`tsx` で実行する selftest スタイルを拡張する。
- private ロジックも回帰検知できるよう、`any` 経由で内部メソッドへアクセスするテストを最小限追加する。

## 追加テスト

1. `src/server/game.selftest.ts` (新規)
   - swap 衝突判定: `resolveGhostCollisions` がすれ違いを検知する
   - dot 再生成セル判定: gate/switch/pellet を除外する
   - auto respawn: grace が付与される
   - `step()` 経由の統合寄りテスト（衝突/autoRespawn発火）
2. `src/server/reconnect.selftest.ts` (新規)
   - `getPlayerByToken` と `setPlayerConnection` の回帰確認
3. `package.json`
   - `test` スクリプトに `test:server-game` を追加
   - `test:server-reconnect` を追加

## ドキュメント

- `docs/local_development.md` に `npm test` の説明を追記する。

## 補足

- `server/index.ts` の reconnect/host まわりの WebSocket 統合テストは次フェーズで専用テスト基盤を追加する前提。
