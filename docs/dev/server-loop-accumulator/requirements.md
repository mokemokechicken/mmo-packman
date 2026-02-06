# Requirements: server-loop-accumulator

## 背景

- 現在のサーバーループは `setInterval` ごとに固定 `TICK_MS` を1回進める方式。
- 負荷やGCで interval が遅延した場合、実時間とゲーム内時間が乖離する。

## 要求

1. ゲーム更新は fixed-step (`TICK_MS`) を維持しつつ、実時間追従できること。
2. 遅延が発生しても、複数step消化で追従すること。
3. 1回のループで処理しすぎないよう上限を設けること（spiral of death 防止）。
4. 既存の終了判定/配信挙動を壊さないこと。
5. 設計意図を `docs/architecture.md` に反映すること。

## 非要求

- ゲームロジック自体（プレイヤーAI/衝突判定）の調整は対象外。
- AOI配信などネットワーク最適化は対象外。
