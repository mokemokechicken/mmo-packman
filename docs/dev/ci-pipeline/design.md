# Design: ci-pipeline

## Overview
`.github/workflows/ci.yml` を追加し、Node + Rust + simulate smokeを1ジョブで順次実行する。

## Trigger
- `pull_request`
- `push` on `main`

## Steps
1. checkout
2. setup-node + `npm ci`
3. package.json から script 有無を検出
4. `npm run check`
5. `npm run build`
6. `npm run test`（`test` script がある場合のみ）
7. `npm run simulate -- ... --seed 12345`（常時）
8. setup-rust toolchain（Rust実装がある場合）
9. `cargo fmt --check`
10. `cargo clippy --all-targets -- -D warnings`
11. `cargo test --all-targets`
12. `simulate:rust` script の存在検証（Rust実装がある場合は必須）
13. `npm run simulate:rust -- ... --seed 12345`

※ Rust実装 (`rust/server/Cargo.toml`) が無い段階では、Rust関連ステップをスキップする条件付き設計とする。

## Validation
- ローカルで同コマンドを先に実行し、CIで再現されることを確認する。
