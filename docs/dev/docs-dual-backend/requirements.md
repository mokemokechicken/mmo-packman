# Requirements: docs-dual-backend

## Goal
TSサーバーとRustサーバーが併存する前提で、設計文書の読解コストを下げる。

## Functional Requirements
1. `docs/architecture.md` に TS/Rust の役割と位置づけを明記する。
2. 「現在の実行系（authoritative path）」を明記する。
3. TS/Rustのパリティ方針（どこまで一致させるか）を明記する。
4. 検証導線（simulate / CI）を明記する。
5. `docs/README.md` から参照しやすくする。

## Non-Functional Requirements
- 新規参加者が5分以内に全体像を把握できる構成にする。
- 既存文書との矛盾を残さない。
