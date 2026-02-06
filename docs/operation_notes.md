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

## 監視/ログ運用（Rust simulate）

### 構造化ログ

- `simulate` は stderr に JSONL で構造化ログを出力する。
- `matchId` 未指定時は `sim-<seed>-<timestamp_ms>` が自動採番される。
- 主要イベント:
  - `scenario_started`
  - `anomaly_detected`
  - `scenario_finished`
  - `run_finished`
  - `summary_write_failed`（`--summary-out` 書き込み失敗時）
- ログ共通フィールド:
  - `matchId`: 実行単位ID（`--match-id` で指定可）
  - `scenario`: シナリオ名
  - `seed`: シナリオseed
  - `tick`: 異常/終了時のtick

実行例:

```bash
cargo run --quiet --manifest-path rust/server/Cargo.toml --bin simulate -- \
  --single --ai 5 --minutes 3 --difficulty normal --seed 42 --match-id ops-check \
  --summary-out /tmp/mmo-packman-summary.json \
  1>/tmp/mmo-packman-result.jsonl 2>/tmp/mmo-packman-log.jsonl
```

異常検知だけを抽出:

```bash
jq -c 'select(.event=="anomaly_detected")' /tmp/mmo-packman-log.jsonl
```

### 試合サマリ（機械可読）

- `--summary-out <path>` を指定すると、実行全体の集約サマリ JSON を出力する。
- サマリには以下を含む:
  - `scenarioCount`, `anomalyCount`, `averageDurationMs`
  - `reasonCounts`（終了理由ごとの件数）
  - `scenarios`（シナリオ別の詳細結果）

### Cloud Run 想定の最低限監視

- Cloud Logging で `event="anomaly_detected"` をログベースメトリクス化する。
- `event="run_finished"` の `averageDurationMs` / `reasonCounts` を定期確認する。
- `matchId` をデプロイ単位・検証バッチ単位で付与し、問題発生時に追跡可能にする。
