# Design: client-sound-events

## Approach
1. クライアントに軽量サウンドマネージャを追加し、Web Audio API で最小SEを合成再生する。
2. `RuntimeEvent` と `game_over` をフックしてイベント別にSEパターンを割り当てる。
3. 画面右下にサウンド設定パネル（音量/ミュート）を追加し、`localStorage` に保存する。
4. 初回ユーザー操作（pointer/keydown）で AudioContext を `resume` し、未解放時は再生をスキップする。
5. アセット運用ルール（将来の実音源配置パス、推奨フォーマット、命名）を `docs/operation_notes.md` に追記する。

## Validation
- `npm run check`
- `npm run build`
- `npm run test`
