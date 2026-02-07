# Requirements: room-id-multi-match

## Goal
Issue #30 の完了条件に合わせ、ルームID単位で複数試合を並行実行できるようにする。

## Functional Requirements
1. クライアントが `roomId` を指定して接続できること（未指定は `main`）。
2. サーバーはルームごとにロビー/ホスト/ゲームループを分離し、同時進行しても干渉しないこと。
3. 既存シングルルーム挙動（`main` ルーム）は後方互換で維持すること。
4. ローカルで複数ルーム検証する手順を docs に追記すること。

## Non-Functional Requirements
- ルーム切替時に既存接続を安全に detach できること。
- `npm run check` / `npm run build` / `npm run test` を pass すること。
