# タイムラプスリプレイ

## 概要
- 試合中の `state` を 4tick ごとにサンプリングし、`game_over` 時に replay ログを確定します。
- ログはクライアント結果画面から JSON 保存でき、後で読み込んで再生できます。

## 生成手順
1. 通常どおり試合を開始して終了まで進める。
2. 結果画面の「リプレイ」セクションで `JSON保存` を押す。
3. `mmo-packman-replay-<seed>-<timestamp>.json` が保存される。

## 再生手順
1. 結果画面の `リプレイJSON読込` で保存済み JSON を選択する。
2. リプレイ再生が開始される（HUD に Replay コントロール表示）。
3. `一時停止/再生` `±速度` `シークバー` `終了` で操作する。

## フォーマット

```json
{
  "format": "mmo-packman-replay-v1",
  "recordedAtIso": "2026-02-07T00:00:00.000Z",
  "seed": 123456789,
  "config": { "difficulty": "normal" },
  "world": { "width": 64, "height": 64 },
  "startedAtMs": 1738886400000,
  "summary": { "reason": "victory" },
  "frames": [
    {
      "snapshot": {
        "tick": 0,
        "nowMs": 1738886400000,
        "players": [],
        "ghosts": [],
        "fruits": [],
        "sectors": [],
        "gates": [],
        "pings": [],
        "events": [],
        "timeline": []
      },
      "dots": ["3,5", "3,6"],
      "pellets": [{ "key": "10,8", "x": 10, "y": 8, "active": true }]
    }
  ]
}
```

- `format` は互換性識別子。
- `seed` と `config` で再現条件を保持。
- `frames.snapshot` は時系列スナップショット（軽量化のため間引きサンプリング）。
- `frames.dots` / `frames.pellets` で盤面状態を復元する。
- `frames` 内に `snapshot/dots/pellets` が欠ける旧形式は読み込み時に拒否される。
