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

## 操作方法

- `Arrow` or `WASD`: 移動
- `Space` / `E` / `Enter`: 覚醒

## 複数人で試す

- ブラウザタブを2つ以上開く
- 1人目（Host）が `ゲーム開始`
