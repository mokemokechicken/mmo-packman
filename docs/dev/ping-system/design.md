# Design: ping-system

## Approach
1. `PingView` と `place_ping` メッセージを shared types に追加し、`Snapshot` に `pings` 配列を拡張する。
2. 参照サーバーに `PingManager` を追加し、TTL掃除・総数上限・プレイヤーごとの投稿頻度制御を一元管理する。
3. サーバーの `state` 送信時に現在有効なピンを `snapshot.pings` として付与し、全接続へ配信する。
4. クライアントでピン送信キー（`G`/`V`/`B`）を追加し、種別ごとに色とラベルを描画する。
5. 観戦者が投稿を試みた場合は送信せずローカルログ表示、サーバー側でも拒否して二重防御する。
6. ピン時刻はゲーム時刻（`snapshot.nowMs` と同系）で統一し、サーバー側で投稿者の現在位置を強制採用して改造クライアント耐性を持たせる。

## Validation
- `npm run check`
- `npm run build`
- `npm run test`
