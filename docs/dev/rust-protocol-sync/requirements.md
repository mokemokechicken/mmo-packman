# Requirements: rust-protocol-sync

## Goal
Issue #64 の完了条件として、Rust WS 実装を shared 契約へ追従させ、クライアントが利用中の `place_ping` / `snapshot.pings` / `game_init.seed` を提供する。

## Functional Requirements
1. Rust サーバーは `place_ping` を受信し、観戦者拒否・レート制御付きでピンを登録できること。
2. `state.snapshot` に `pings` を含めて配信できること。
3. `game_init` に `seed` を含めること。
4. `hello.roomId` を受理し、現時点で未サポートのルーム指定は明示エラーにすること（silent fallback を避ける）。

## Non-Functional Requirements
- 既存の接続/再接続/試合進行を壊さない。
- `npm run check` / `npm run build` / `npm run test` / `cargo test --manifest-path rust/server/Cargo.toml --all-targets` を pass する。
