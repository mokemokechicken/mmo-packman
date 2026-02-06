# AI-only テストプレイ手順

## 目的

- 1〜10分の短時間試行で、以下を確認する
  - 不具合・異常動作（例: NaN座標、進行停止）
  - 極端なバランス崩壊（序盤即壊滅、終盤で破綻など）

## 推奨シナリオ

- `AI x2` : 簡易動作確認（2〜5分）
- `AI x5` : バランス初期確認（5〜10分）

## UIで実施

1. `npm run dev`
2. ブラウザで `http://localhost:5173`
3. `参加モード: 観戦`
4. `AIプレイヤー数` と `テスト時間` を設定
5. Host で `テスト開始`

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

### seed 指定で再現実行

```bash
npm run simulate -- --single --ai 20 --minutes 10 --difficulty normal --seed 12345
npm run simulate -- --seed 12345
```

- 出力 JSON の `seed` を保存しておくと、同条件で再現できる。
- `--seed` 未指定時も、実際に使われた `seed` は結果に出力される。
- デフォルト2シナリオ時は `seed=base` と `seed=base+1` が使われる。
- `--seed` は `uint32 (0..4294967295)` として正規化して利用される。

## 出力の見方

JSON 1行ごとに1シナリオ結果を出す。

主要フィールド:

- `reason`: 終了理由 (`victory|timeout|all_down|collapse`)
- `seed`: 実行に使った乱数seed（再現実行用）
- `maxCapture`: 最大制覇率
- `minCaptureAfter70`: 制覇率70%到達後の最低制覇率
- `downs`, `rescues`: 被弾と立て直し傾向
- `sectorCaptured`, `sectorLost`: 制圧と劣化の攻防
- `anomalies`: 異常検知（空配列が正常）

## 目安

- `anomalies` が空であること
- 同条件で複数回回して、毎回即全滅しないこと
- `AI x5` で `maxCapture` がある程度上がること
