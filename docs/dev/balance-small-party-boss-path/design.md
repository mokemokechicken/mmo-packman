# Design: balance-small-party-boss-path

## Approach
1. 少人数時に限ってボス出現開始条件を前倒しする（大人数の既存条件は維持）。
2. 少人数時のボス耐久を調整し、AIの覚醒追跡でヒットが発生しやすい導線を作る。
3. 実装はゴーストタイプ選択とボスHP決定に局所化し、他システムへの影響を最小化する。
4. ユニットテストで「少人数時のボス出現」「少人数時ボス耐久」の回帰を固定する。

## Validation
- `cargo test --manifest-path rust/server/Cargo.toml --all-targets`
- `cargo clippy --manifest-path rust/server/Cargo.toml --all-targets -- -D warnings`
- `npm run check`
- `npm run build`
- `npm run test`
- `AI x2/x5 / casual / 10分` の代表seedで `bossSpawned` / `bossHits` を集計確認
