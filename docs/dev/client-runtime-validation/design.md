# Design: client-runtime-validation

## 方針

- `parseServerMessage(raw: string): ServerMessage | null` を専用モジュールに切り出す。
- `type` ごとに最低限必要なフィールドを厳格チェックする。
- チェック失敗時は `null` を返し、呼び出し側でログ出力して無視する。

## 対象メッセージ

- `welcome`
- `lobby`
- `game_init`
- `state`
- `game_over`
- `error`
- `pong`

## 実装方針

1. 共通ユーティリティ (`isRecord`, `isString`, `isNumber`, etc.) を用意。
2. ネスト構造 (`snapshot`, `world`, `summary`) も必要項目を検証。
3. `state.events` は以下で扱う。
   - 未知イベント: そのイベントのみ破棄（前方互換）
   - 既知イベントの破損: `state` 全体を破棄（不整合防止）
4. `main.ts` は `JSON.parse` 直接利用をやめ、専用 parser を利用。
5. `docs/server_protocol.md` に「不正payloadはクライアントが破棄する」運用を追記。

## 影響範囲

- `src/client/main.ts`
- `src/client/parseServerMessage.ts` (新規)
- `docs/server_protocol.md`
