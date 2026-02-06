# TS/Rust パリティ検証ハーネス

## 目的
TypeScript サーバー実装と Rust サーバー実装を同条件で並走させ、主要メトリクス差分を早期検知する。

## 実行コマンド

```bash
npm run test:parity
```

既定値:
- `--ai 5`
- `--minutes 3`
- `--difficulty normal`
- `--seed-start 1001`
- `--seed-count 10`
- `--capture-tolerance 0.2`

## 主なオプション

```bash
npm run test:parity -- --seed-count 20 --minutes 2
npm run test:parity -- --seeds 101,202,303 --ai 10 --minutes 5
npm run test:parity -- --report-file /tmp/parity-report.json
```

- `--seeds`: カンマ区切りseedを直接指定
- `--seed-start` + `--seed-count`: 連番seedを指定
- `--capture-tolerance`: `maxCapture` と `minCaptureAfter70` の許容差（ポイント）
- `--report-file`: 結果JSONの保存先
- `--seed-start` / `--seeds` は `0..4294967295` の整数のみ許可（不正値は即エラー）

## 比較項目

- 完全一致:
  - `reason`
  - `anomalies.length`
  - `dotEaten`, `dotRespawned`, `downs`, `rescues`
  - `sectorCaptured`, `sectorLost`, `bossSpawned`, `bossHits`
- 許容誤差:
  - `maxCapture`, `minCaptureAfter70`（既定 ±0.2）

## 失敗時の見方

- 失敗ケースごとに以下を表示:
  - seed / 実行条件
  - TS結果とRust結果
  - 差分項目
  - 再実行に使えるコマンド
- 出力された seed を固定して再実行すると再現確認しやすい。
- 差分が1件でもあると終了コードは `1` になる（CIでは non-blocking 実行設定により監視運用可能）。
