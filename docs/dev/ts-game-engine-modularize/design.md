# Design: ts-game-engine-modularize

## Approach
- `src/server/game_rules.ts` に移動/境界/ゲージなどの純ロジック判定を集約。
- `src/server/gate_utils.ts` にゲート関連のセル集合/判定ロジックを集約。
- `GameEngine` は状態遷移のオーケストレーションに寄せる。
- `game_rules.selftest.ts` / `gate_utils.selftest.ts` / `game.selftest.ts` を更新・拡充する。

## Validation
- `npm run check`
- `npm run build`
- `npm run test`
- `npm run simulate -- --single --ai 2 --minutes 1 --difficulty normal --seed 12345`
