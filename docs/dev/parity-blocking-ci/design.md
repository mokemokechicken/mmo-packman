# Design: parity-blocking-ci

## Approach
1. parity 実行コマンドを npm script 化（`test:parity`）し、ローカル/CI で同一経路を使う。
2. CI ワークフローに parity ステップを追加し、`continue-on-error` は使わず blocking で実行する。
3. `docs/parity_harness.md` に以下を明記する。
   - 比較対象メトリクス
   - 許容差分（現時点で仕様差分として扱う項目）
   - 推奨実行コマンド（ローカル/CI）
4. 代表seed群（normal, ai=5, minutes=1, 20 seeds）で「不許容差分ゼロ」を確認し、記録する。

## Validation
- `npx -y tsx reference/ts-server/src/server/parity_harness.ts --ai 5 --minutes 1 --difficulty normal --seed-start 1101 --seed-count 20`
- `npm run check`
- `npm run build`
- `npm run test`
