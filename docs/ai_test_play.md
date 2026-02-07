# AI-only テストプレイ手順

## 目的

- 1〜10分の短時間試行で、以下を確認する
  - 不具合・異常動作（例: NaN座標、進行停止）
  - 極端なバランス崩壊（序盤即壊滅、終盤で破綻など）

## 推奨シナリオ

- `AI x2` : 簡易動作確認（2〜5分）
- `AI x5` : バランス初期確認（5〜10分）

## UIで実施（準備中）

- Rust WebSocket サーバーが未実装のため、現在は UI 実施は準備中。
- 追跡Issue: [#27](https://github.com/mokemokechicken/mmo-packman/issues/27)

## CLIで実施

### デフォルト（2シナリオ）

```bash
npm run simulate
```

### 任意シナリオ

```bash
npm run simulate -- --single --ai 2 --minutes 5 --difficulty normal
npm run simulate -- --single --ai 5 --minutes 10 --difficulty normal
```

## 出力の見方

JSON 1行ごとに1シナリオ結果を出す。

主要フィールド:

- `reason`: 終了理由 (`victory|timeout|all_down|collapse`)
- `maxCapture`: 最大制覇率
- `minCaptureAfter70`: 制覇率70%到達後の最低制覇率
- `downs`, `rescues`: 被弾と立て直し傾向
- `sectorCaptured`, `sectorLost`: 制圧と劣化の攻防
- `bossSpawned`, `bossHits`: ボス遭遇数とボス被弾数
- `anomalies`: 異常検知（空配列が正常）

## 目安

- `anomalies` が空であること
- 同条件で複数回回して、毎回即全滅しないこと
- `AI x5` で `maxCapture` がある程度上がること

## 12.3 向け少人数ボス導線観測

代表シナリオ:

- `AI x2 / casual / 10分 / seed 1001-1010`
- `AI x5 / casual / 10分 / seed 4001-4005`

観測指標:

- `bossSpawnedTotal`: 代表seed群で 1 以上（遭遇導線が成立している）
- `bossHitsTotal`: 代表seed群で 1 以上（撃破導線の評価が可能）

集計例:

```bash
for seed in $(seq 1001 1010); do
  npm run -s simulate -- --single --ai 2 --minutes 10 --difficulty casual --seed "$seed"
done
for seed in $(seq 4001 4005); do
  npm run -s simulate -- --single --ai 5 --minutes 10 --difficulty casual --seed "$seed"
done
```

最新計測（2026-02-07, issue #44 対応後）:

- `AI x2`: `bossSpawnedTotal=19`, `bossHitsTotal=13`
- `AI x5`: `bossSpawnedTotal=13`, `bossHitsTotal=20`
