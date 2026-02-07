# Requirements: timelapse-replay

## Goal
Issue #31 の完了条件に合わせ、1試合分のイベントログを軽量JSONで保存し、クライアント上でタイムラプス再生（速度変更/シーク）できるようにする。

## Functional Requirements
1. 試合中の `state` をサンプリングし、試合終了時に replay ログ（seed/ルール情報含む）を生成できること。
2. 結果画面から replay JSON を保存でき、JSON を読み込んで再生を開始できること。
3. 再生中に play/pause、速度変更、シークが可能であること。
4. replay 形式と生成/再生手順を docs に記載すること。

## Non-Functional Requirements
- 既存の通常プレイ進行（入力・描画・結果表示）を壊さないこと。
- `npm run check` / `npm run build` / `npm run test` を pass すること。
