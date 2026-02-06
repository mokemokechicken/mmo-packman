# Design: rust-engine-modularize

## Approach
1. 既存の Rust server 実装を取り込む。
2. `engine` を責務ごとに分割する。
   - core (constructor/step/snapshot)
   - player system
   - ghost system
   - sector & spawn system
3. 既存テストを維持し、必要に応じて参照パスのみ調整する。

## Validation
- cargo fmt --all
- cargo test --all-targets
- cargo clippy --all-targets -- -D warnings
- npm run check
- npm run build
- npm run simulate:rust -- --single --ai 10 --minutes 10 --difficulty normal --seed 424242
