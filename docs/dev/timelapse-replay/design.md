# Design: timelapse-replay

## Approach
1. `game_init` に `seed` を追加し、クライアントが replay メタデータ（seed, config, world, summary）を揃えられるようにする。
2. クライアントで `state` を4tickごとにサンプリングして `Snapshot` と盤面状態（dots/pellets）を録画し、`game_over` で `ReplayLog` を確定する。
3. 結果画面に replay 保存/読込導線を追加し、JSON I/O を提供する。
4. HUD に replay 操作（再生/停止、速度、シーク、終了）を追加し、フレーム時刻ベースで再生カーソルを進める。
5. replay 読込時は format/version の最小検証を行い、不正フォーマットはログ通知して無視する。

## Validation
- `npm run check`
- `npm run build`
- `npm run test`
