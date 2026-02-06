# Requirements: ci-pipeline

## Goal
PRごとに最低限の品質ゲートを自動実行し、手動実行漏れを防ぐ。

## Functional Requirements
1. GitHub ActionsでPRとmain更新時に実行されること。
2. Node側の `check/build` を実行すること。`test` スクリプトが存在する場合は `test` を実行すること。
3. Rust実装が存在する場合は `fmt --check/clippy -D warnings/test` を実行すること。
4. TSのsimulate smokeを実行すること。Rust実装が存在する場合はRust simulate smokeも実行すること。
5. simulate smokeは固定seedで実行し、再現性を担保すること。

## Non-Functional Requirements
- 実行失敗時に原因がジョブログから判断できること。
- ワークフローは単一ファイルで見通しよく管理すること。

## Out of Scope
- キャッシュ最適化の微調整
- 並列ジョブの細かい分割
