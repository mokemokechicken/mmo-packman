# Design: server-game-modularize

## 方針

- `GameEngine` から副作用のないヘルパー関数群を先に抽出する。
- 既存呼び出し箇所を置き換え、振る舞い差分を出さない。

## 分離対象

1. `src/server/game_rules.ts` (新規)
   - `pickGhostType`
   - `pickFruitType`
   - `oppositeOf`
   - `isMoveDirection`
2. `src/server/gate_utils.ts` (新規)
   - `isGateCellOrSwitch`

## 変更点

- `game.ts` の同名関数を削除し、新規モジュールから import する。
- `world.ts` でも gate/switch 判定をユーティリティ化し、重複を削減する。
- `world.ts` は gate/switch セル集合を事前計算 (`Set`) し、セル走査時の計算量悪化を防ぐ。
- `game_rules.ts` は `next(): number` を持つ抽象型を受けるようにし、`Rng` 具象への結合を弱める。
- 回帰防止として `gate_utils` / `world` / `game_rules` の selftest を追加する。

## 影響範囲

- `src/server/game.ts`
- `src/server/world.ts`
- `src/server/game_rules.ts` (新規)
- `src/server/gate_utils.ts` (新規)
