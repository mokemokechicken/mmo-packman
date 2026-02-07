# Design: balance-large-scenario-endgame

## Approach
1. 80〜100人帯のみ適用される終盤圧緩和係数を導入し、維持コストの過剰上昇を抑える。
2. 80〜100人帯ではセクター掌握判定を「残ドット35%以下」に緩和し、終盤到達テンポを改善する。
3. 大人数時のゴースト人口増加ペースを抑え、制圧速度と防衛負荷のバランスを再調整する。
4. 調整は `GameEngine` 内の80〜100人帯条件分岐に閉じ、79人以下への影響を最小化する。
5. ユニットテストで係数境界（79/80/101）と掌握判定の適用範囲を固定する。

## Validation
- `cargo test --manifest-path rust/server/Cargo.toml --all-targets`
- `cargo clippy --manifest-path rust/server/Cargo.toml --all-targets -- -D warnings`
- `npm run check`
- `npm run build`
- `npm run test`
- `AI x80 / normal / 10分 / seed 3001-3002` 集計で `avgMaxCapture >= 70%`
