# Design: rule-constants-single-source

## Approach
- `config/game_rules.json` を定数の単一ソースとして追加。
- `scripts/generate-game-rules.mjs` を追加し、以下を生成する。
  - `src/shared/constants.ts`
  - `rust/server/src/constants.rs`
- generatorにJSON妥当性検証（型/範囲/閾値の昇順/Rust型上限）を実装する。
- package script に生成コマンドと整合チェックコマンドを追加する。

## Generation Policy
- 生成ファイル先頭に generated コメントを付ける。
- 手編集を避け、変更は原本JSON + 生成実行で行う。
- `npm run check` 実行時に `--check` モードで生成物ドリフトを検知する。
- generator selftest を `npm run test` に含める。

## Validation
- npm run generate:game-rules
- npm run generate:game-rules:check
- npm run check
- npm run build
- npm run test
- cargo test --manifest-path rust/server/Cargo.toml --all-targets
