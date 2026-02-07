# 運用メモ / バランス調整観点

## まず見るべきメトリクス

- 平均ゲーム時間
- 勝率（難易度別）
- 制覇率70%到達後の敗北率
- 平均ダウン回数
- ボス出現率 / 撃破率

## 典型的な調整ポイント

- 終盤が厳しすぎる
  - `getCapturePressure` の `regenMultiplier` を下げる
  - 侵攻ゴーストの増加ペースを抑える
- 序盤が退屈
  - 初期ゴースト数を増やす
  - フルーツ湧きを遅らせる
- 少人数が苦しすぎる
  - ゴースト速度補正をさらに下げる
  - フルーツ出現頻度を上げる

## AI代行品質の定期観測（少人数離脱耐性）

対象シナリオ:

- `AI x2 / casual / 10分 / seed 1001-1010`

観測指標:

- `allDownRate`: `reason == all_down` の割合（目標: 20% 以下）
- `avgRescues`: 平均救助回数（救助行動の実効性確認）
- `avgMaxCapture`: 平均最大制覇率（進行停滞の早期検知）

計測コマンド:

```bash
for seed in $(seq 1001 1010); do
  npm run -s simulate -- --single --ai 2 --minutes 10 --difficulty casual --seed "$seed"
done
```

最新計測（2026-02-07, issue #45 対応後）:

- `allDownRate: 0.0%`（10試行中 0件）
- `avgRescues: 1.2`
- `avgMaxCapture: 5.0%`

参考ベースライン（調整前）:

- `allDownRate: 30.0%`（10試行中 3件）

## 大人数終盤到達性の定期観測（Issue #43）

対象シナリオ:

- `AI x80 / normal / 10分 / seed 3001-3002`
- `AI x100 / normal / 10分 / seed 3101-3102`

観測指標:

- `avgMaxCapture`: 代表seed群の平均最大制覇率（目標: 70%以上）
- `allDownRate`: `reason == all_down` の割合（大人数バランス破綻の早期検知）
- `sectorLostTotal`: セクター喪失イベント総数（終盤維持コスト過多の監視）

仕様メモ:

- issue #43 では 80〜100人帯のみ、残ドット35%以下を「セクター掌握」として扱う。

計測コマンド:

```bash
for seed in 3001 3002; do
  npm run -s simulate -- --single --ai 80 --minutes 10 --difficulty normal --seed "$seed"
done
for seed in 3101 3102; do
  npm run -s simulate -- --single --ai 100 --minutes 10 --difficulty normal --seed "$seed"
done
```

最新計測（2026-02-07, issue #43 対応後）:

- `AI x80`: `maxCapture=83.3, 80.6`（`avgMaxCapture=81.95%`）, `allDownRate=0%`, `sectorLostTotal=1`
- `AI x100`: `maxCapture=94.4, 88.9`（`avgMaxCapture=91.65%`）, `allDownRate=0%`, `sectorLostTotal=2`

参考ベースライン（調整前, issue #43 着手前）:

- `AI x80`: `maxCapture=25.0, 13.9`（`avgMaxCapture=19.45%`）

## 5人カジュアルのクリア成立性観測（Issue #42）

対象シナリオ:

- `AI x5 / casual / 10分 / seed 4001-4005`

観測指標:

- `victoryCount`: `reason == victory` の件数（目標: 1件以上）
- `avgMaxCapture`: 代表seed群の平均最大制覇率

仕様メモ:

- issue #42 では 5人カジュアルのみ、終盤支援の係数（掌握・喪失しきい値、維持コスト、敵圧）を調整する。

計測コマンド:

```bash
for seed in $(seq 4001 4005); do
  npm run -s simulate -- --single --ai 5 --minutes 10 --difficulty casual --seed "$seed"
done
```

最新計測（2026-02-07, issue #42 対応後）:

- `victoryCount=3/5`（seed `4001`, `4002`, `4005`）
- `avgMaxCapture=85.0%`

参考ベースライン（調整前）:

- `victoryCount=0/5`
- `avgMaxCapture=25.0%`

## 既知のMVP制約

- 永続化なし
- 単一ルーム運用
- セキュリティ（認証/署名）未実装
- パフォーマンス最適化は最低限

## 次フェーズ候補

1. ルームID対応（複数同時試合）
2. AOI配信
3. 簡易リプレイ（タイムライン + 俯瞰再生）
4. 永続戦績（ランキング）
5. 監視/ログ整備
