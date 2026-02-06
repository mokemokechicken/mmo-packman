# Cloud Run デプロイ手順（MVP）

このプロトタイプは Cloud Run で動かせます。WebSocket利用のため、Cloud Run のHTTPエンドポイントでそのまま運用可能です。

## 1. Dockerfile

```Dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/server/server/index.js"]
```

## 2. Build / Push

```bash
gcloud builds submit --tag gcr.io/<PROJECT_ID>/mmo-packman:latest
```

## 3. Deploy

```bash
gcloud run deploy mmo-packman \
  --image gcr.io/<PROJECT_ID>/mmo-packman:latest \
  --platform managed \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --port 8080
```

## 4. 補足

- 最小インスタンス数 0 でコストを抑えられます（コールドスタートは増える）
- MVPではメモリ上で状態管理しているため、インスタンス再起動でゲーム状態は消えます
- 本番化時はセッション・ルーム管理を外部ストア化してください
