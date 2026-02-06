# ローカル開発ガイド

## 必要環境

- Node.js 20+
- npm

## セットアップ

```bash
npm install
```

## 開発起動

```bash
npm run dev
```

- サーバー: `http://localhost:8080`
- クライアント(Vite): `http://localhost:5173`

Viteで開いた場合、クライアントは自動で `ws://localhost:8080/ws` に接続します。

## ビルド

```bash
npm run build
```

生成物:

- `dist/client/`
- `dist/server/`

## 本番起動（ローカル確認）

```bash
npm run start
```

## 型チェック

```bash
npm run check
```

## 自動テスト

```bash
npm run test
```

## AI-onlyテストプレイ（UI）

1. ブラウザで `http://localhost:5173` を開く
2. 参加モードを `観戦` にする
3. `AIプレイヤー数` を設定（例: `2`, `5`）
4. `テスト時間` を設定（`1〜10`分）
5. Host で `テスト開始`

## AI-onlyテストプレイ（CLI）

```bash
npm run simulate
```

デフォルト実行:

- `quick-check-ai2` (2分)
- `balance-check-ai5` (5分)

カスタム実行例:

```bash
npm run simulate -- --single --ai 5 --minutes 10 --difficulty normal
npm run simulate -- --single --ai 20 --minutes 10 --difficulty normal --seed 12345
```

再現実行メモ:

- `--seed` を指定すると同条件を再現しやすくなる。
- `--seed` 未指定でも出力JSONに `seed` が出るため、後から同値で再実行できる。

## 操作方法

プレイヤーモード:

- `Arrow` or `WASD`: 移動
- `Space` / `E` / `Enter`: 覚醒

観戦モード:

- `Tab`: 追従対象の切り替え
