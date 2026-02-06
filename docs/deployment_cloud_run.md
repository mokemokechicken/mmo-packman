# Cloud Run デプロイ手順

## 前提

- Rust WebSocket サーバー (`rust/server/src/bin/server.rs`) を Cloud Run にデプロイする。
- コンテナ起動時は `PORT` 環境変数（Cloud Run が注入）で待受する。

## ローカル確認

```bash
docker build -t mmo-packman-rust-server .
docker run --rm -p 8080:8080 mmo-packman-rust-server
```

確認:

```bash
curl -s http://localhost:8080/healthz
```

## Cloud Run デプロイ

```bash
gcloud run deploy mmo-packman-rust-server \
  --source . \
  --region asia-northeast1 \
  --allow-unauthenticated
```

## 動作確認

- health check: `GET /healthz`
- WebSocket: `/ws`

## 補足

- 現在の Dockerfile は Rust `server` バイナリのみを実行する。
- 静的フロント配信は別ホスティング（または別サービス）で運用する前提。
