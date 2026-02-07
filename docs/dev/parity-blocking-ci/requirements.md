# Requirements: parity-blocking-ci

## Goal
Issue #28 の完了条件に合わせ、TS/Rust parity を実運用可能な blocking チェックへ移行し、許容差分ルールを明文化する。

## Functional Requirements
1. 代表seed群で parity 差分を確認し、不許容差分がゼロであることを検証すること。
2. 許容差分の定義と根拠を `docs/parity_harness.md` に記載すること。
3. CI に parity チェックを追加し、失敗時にジョブを落とす（blocking）こと。

## Non-Functional Requirements
- parity 実行時間は CI で実用的な範囲（軽量 seed 数）に収めること。
- 既存の check/build/test フローを壊さないこと。
