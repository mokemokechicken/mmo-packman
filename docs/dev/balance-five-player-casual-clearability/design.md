# Design: balance-five-player-casual-clearability

## Approach
1. 5人カジュアル限定で終盤支援係数を導入する。移動速度補正は `capture_ratio >= 0.4` で有効化し、終盤のみ押し切りやすくする。
2. 5人カジュアル限定で敵圧（ゴースト人口や追跡圧）を緩和する。ゴースト目標数は制覇率に応じて `4 -> 5` へ段階増加させる。
3. 調整は `GameEngine` 内の5人カジュアル条件分岐へ閉じ、他帯域への影響を最小化する。
4. ユニットテストで適用境界（人数・難易度）と挙動（速度補正の有効化条件、掌握/喪失しきい値、ゴースト目標数）を固定する。

## Validation
- `cargo test --manifest-path rust/server/Cargo.toml --all-targets`
- `cargo clippy --manifest-path rust/server/Cargo.toml --all-targets -- -D warnings`
- `npm run check`
- `npm run build`
- `npm run test`
- `AI x5 / casual / 10分 / seed 4001-4005` で `victory >= 1件`
