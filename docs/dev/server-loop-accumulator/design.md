# Design: server-loop-accumulator

## 方針

- `setInterval` はトリガーとして使い、実更新は accumulator で制御する。
- `performance.now()` で実経過時間を計測し、`accumulatorMs` に積む。
- `while (accumulatorMs >= TICK_MS)` で固定stepを複数回消化する。

## 仕様

1. ループ内で `deltaMs = now - prev` を計算。
2. `deltaMs` は上限で clamp（過大遅延の一括処理を防ぐ）。
3. `MAX_STEPS_PER_INTERVAL = ceil(MAX_FRAME_DELTA_MS / TICK_MS)` とし、clampしたdeltaを理論上消化できる上限にする。
4. それでもstep上限到達で backlog が残る場合は、tick境界まで圧縮して過負荷連鎖を防ぐ（追従性とのトレードオフ）。
5. stepが1回以上進んだタイミングで `state` を配信。
6. `running.isEnded()` 検知時の後処理（`game_over`, loop停止, lobby復帰）は既存と同等。

## 影響範囲

- `src/server/index.ts`
  - ループ処理を accumulator 方式に変更
- `docs/architecture.md`
  - 固定step + 実時間追従の説明を追記
