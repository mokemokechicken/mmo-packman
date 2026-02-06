# Design: balance-checklist-12-3

## Approach
1. `rust/server/target/debug/simulate` を使い、以下を実行する。
   - AI x2, casual, 10分, seed 1001-1010
   - AI x5, normal, 10分, seed 2001-2010
   - AI x5, casual, 10分, seed 4001-4005
   - AI x80, normal, 10分, seed 3001-3002
2. 結果JSONLを `jq` で集計し、平均値と終了理由率を算出する。
3. `docs/game_design.md` 12.3 に判定（OK/NG/保留）を追記する。
4. `NG` 項目について `gh issue create` で改善Issueを起票し、12.3へリンクする。
5. `docs/ai_test_play.md` に定期観測手順としきい値を追記する。

## Repro Commands

```bash
out=/tmp/balance_12_3_results.jsonl
: > "$out"
for seed in $(seq 1001 1010); do
  rust/server/target/debug/simulate --single --ai 2 --minutes 10 --difficulty casual --seed "$seed" >> "$out"
done
for seed in $(seq 2001 2010); do
  rust/server/target/debug/simulate --single --ai 5 --minutes 10 --difficulty normal --seed "$seed" >> "$out"
done
for seed in $(seq 4001 4005); do
  rust/server/target/debug/simulate --single --ai 5 --minutes 10 --difficulty casual --seed "$seed" >> "$out"
done
for seed in 3001 3002; do
  rust/server/target/debug/simulate --single --ai 80 --minutes 10 --difficulty normal --seed "$seed" >> "$out"
done
```

```bash
jq -s '
  def avg(f): (map(f) | if length==0 then 0 else add/length end);
  map(. + {group: ((.aiPlayers|tostring) + ":" + .difficulty)})
  | group_by(.group)
  | map({
      key: .[0].group,
      count: length,
      avgDurationMs: (avg(.durationMs)),
      avgMaxCapture: (avg(.maxCapture)),
      timeoutRate: ((map(select(.reason=="timeout"))|length)/length),
      allDownRate: ((map(select(.reason=="all_down"))|length)/length),
      anomalyRate: ((map(select((.anomalies|length)>0))|length)/length)
    })
' /tmp/balance_12_3_results.jsonl
```

判定補助（個別指標）:

```bash
jq -s '
  {
    bossSpawnedTotal: (map(.bossSpawned) | add),
    bossHitsTotal: (map(.bossHits) | add),
    maxCapture90OrMore: (map(select(.maxCapture >= 90)) | length),
    reasonCounts: (group_by(.reason) | map({key: .[0].reason, count: length}))
  }
' /tmp/balance_12_3_results.jsonl
```

## Decision Matrix

| 項目 | Metric | Threshold | Sample Size | 判定規則 |
|---|---|---|---|---|
| 5人クリア可能性 | victory count (AI x5 casual) | 1件以上 / 5試行 | 5 | 未達なら `NG` |
| 100人終盤緊張感（本測） | avgMaxCapture (AI x100 normal) | 70%以上到達の試合が存在 | 10 | 未実施は `保留` |
| 大人数終盤到達（近似監視） | avgMaxCapture (AI x80 normal) | 50%以上を目標 | 2以上 | 本測未実施時の先行監視指標 |
| 90%以降の進行性 | minCaptureAfter70 / 90%以上到達有無 | 90%到達後の極端崩壊なし | 10 | 高制覇率未到達なら `保留` |
| 少人数ボス撃破 | bossSpawned / bossHits / 撃破件数 | 遭遇・撃破データ取得可 | 10 | 取得不能なら `NG` |
| アップル必須性 | fruitType別寄与 | アップル非依存で成立 | 10 | 指標未整備は `保留` |
| 時間目標15-30分 | durationMs | 900000〜1800000ms | 10 | 固定10分試験のみなら `保留` |
| 覚醒50ドット妥当性 | A/B比較勝率・崩壊率 | しきい値内（別途定義） | 10x2 | A/B未実施は `保留` |
| パワーエサ90秒妥当性 | A/B比較勝率・崩壊率 | しきい値内（別途定義） | 10x2 | A/B未実施は `保留` |
| AI強すぎ判定 | human+AI と human-only の比較 | 人間寄与が消失しない | 10 | 混在比較未実施は `保留` |
| AI弱すぎ判定 | allDownRate（離脱注入） | 20%以下 | 10 | 離脱注入未実施は `保留` |
| 戦場の霧体験 | プレイテスト主観評価 | ネガティブ多数でない | 10セッション | 主観テスト未実施は `保留` |
| 自動復活ペナルティ | 再崩壊率 / 復帰時間 | 過剰負荷でない | 10 | 指標不足は `保留` |

## Validation
1. `npm run check`
2. `npm run build`
3. `npm run test`
4. `cargo test --manifest-path rust/server/Cargo.toml --all-targets`
5. 記録した simulate コマンドと `jq` 集計が再実行できること
