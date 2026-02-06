# Requirements: regression-test-suite

## 背景

- 既存の `check/build/simulate` だけでは、再接続・衝突・再生成などの境界条件回帰を早期検知しづらい。
- 直近で修正した高リスク領域に対して、固定テストケースを増やす必要がある。

## 要求

1. `npm test` で複数の自己テストを実行できる状態にする。
2. 以下の高リスク観点に対して回帰テストを追加する。
   - reconnect関連（token検索/接続状態反映）
   - swap 衝突検知
   - dot 再生成セルの妥当性（gate/switch/pellet除外）
   - auto respawn の grace 付与
3. テスト追加後も `check/build/test` が通ること。
4. テスト方針を docs に明文化すること。

## 非要求

- 本格的なE2E基盤導入（Playwright等）はこのIssueでは行わない。
- 全コードパス網羅は目標にしない。
