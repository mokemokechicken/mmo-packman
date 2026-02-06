# AI-only テストプレイ手順

## 目的

- 1〜10分の短時間試行で、以下を確認する
  - 不具合・異常動作（例: NaN座標、進行停止）
  - 極端なバランス崩壊（序盤即壊滅、終盤で破綻など）

## 推奨シナリオ

- `AI x2` : 簡易動作確認（2〜5分）
- `AI x5` : バランス初期確認（5〜10分）
- `AI x80` : 大人数近似検証（10分）

## UIで実施

- Rust WebSocket サーバーを起動する。

```bash
npm run start:rust-server
```

- 別ターミナルでクライアントを起動する。

```bash
npm run dev
```

## CLIで実施

### デフォルト（2シナリオ）

```bash
npm run simulate
```

### 任意シナリオ

```bash
npm run simulate -- --single --ai 2 --minutes 5 --difficulty normal
npm run simulate -- --single --ai 5 --minutes 10 --difficulty normal
npm run simulate -- --single --ai 80 --minutes 10 --difficulty normal
```

## 出力の見方

JSON 1行ごとに1シナリオ結果を出す。

主要フィールド:

- `reason`: 終了理由 (`victory|timeout|all_down|collapse`)
- `maxCapture`: 最大制覇率
- `minCaptureAfter70`: 制覇率70%到達後の最低制覇率
- `downs`, `rescues`: 被弾と立て直し傾向
- `sectorCaptured`, `sectorLost`: 制圧と劣化の攻防
- `anomalies`: 異常検知（空配列が正常）

## 目安

- `anomalies` が空であること
- 同条件で複数回回して、毎回即全滅しないこと
- `AI x5` で `maxCapture` がある程度上がること

## 定期観測（12.3 向け）

基準シナリオ（2026-02-07時点）:

- AI x2 / casual / 10分 / seed 1001-1010
- AI x5 / normal / 10分 / seed 2001-2010
- AI x5 / casual / 10分 / seed 4001-4005
- AI x80 / normal / 10分 / seed 3001-3002（大人数近似の先行監視）
- AI x100 / normal / 10分 / seed 5001-5010（本測, 未実施）

観測しきい値（暫定）:

- `anomalyRate`: 0% を維持
- `AI x2 casual allDownRate`: 20% 以下を目標（現状 30%）
- `AI x5 casual victory`: 1件以上/5試行を目標（現状 0件）
- `AI x80 normal avgMaxCapture`（近似監視）: 50%以上を目標（現状 33.3%）
- `AI x100 normal`（本測）: 70%以上到達試合が存在すること（未計測）

NG時の改善Issue:

- [#42](https://github.com/mokemokechicken/mmo-packman/issues/42)
- [#43](https://github.com/mokemokechicken/mmo-packman/issues/43)
- [#44](https://github.com/mokemokechicken/mmo-packman/issues/44)
- [#45](https://github.com/mokemokechicken/mmo-packman/issues/45)
