# local_ocr — 設計ドキュメント

## 目的

外出先のスマホから自宅ノートPCへ画像を送り、Ollama上のローカルビジョンモデルだけで
OCRしてテキストを返す。公開クラウド、外部LLM API、画像の永続保存は使わない。

## 構成

```text
スマホブラウザ
  └─ Tailscale
      └─ local_ocr / Node.js :8005
          └─ Ollama API 127.0.0.1:11434
              └─ qwen3-vl:8b / RTX 5060 Laptop GPU
```

```text
tools/local_ocr/
├── server.mjs          # HTTP/API、Ollama呼び出し、doctor
├── static/index.html   # スマホUI、画像縮小、コピー、TXT保存
├── README.md
├── DESIGN.md
└── CONTEXT.md
```

## 処理フロー

1. スマホのブラウザで撮影または画像選択
2. ブラウザでEXIF適用済み画像を読み、長辺最大3,000pxのJPEGへ変換
3. `POST /api/ocr`へData URLをJSON送信
4. サーバーがリクエスト上限、MIME、画像シグネチャを検証
5. 画像をメモリ上でbase64化したままOllama `/api/generate`へ送信
6. OCR本文をJSONで返し、スマホの編集可能なテキスト欄へ表示
7. リクエスト終了後は画像・本文を保持しない

## API

| Method | Path | 内容 |
|---|---|---|
| `GET` | `/` | スマホUI |
| `GET` | `/health` | Webプロセスの生存確認 |
| `GET` | `/api/health` | Ollama接続とモデル導入状態 |
| `POST` | `/api/ocr` | `{image: "data:image/...;base64,..."}`をOCR |

成功応答:

```json
{
  "text": "抽出本文",
  "model": "qwen3-vl:8b",
  "elapsed_ms": 33000
}
```

主なエラーは`400`（画像不正）、`413`（サイズ超過）、`415`（JSON以外）、
`429`（別のOCRを処理中）、`503`（Ollama停止）、`504`（360秒タイムアウト）。

## モデル設定

- モデル: `qwen3-vl:8b`
- thinking: 無効
- temperature: `0`
- context: `8192`
- 最大出力: `4096`
- keep alive: `2m`

`4096` contextでは実画像の入力が4,117 tokensとなり拒否されたため、実機確認後に`8192`へ固定した。
モデルは約6.4GBをGPUへ載せ、同時OCRを1件に制限して8GB VRAM内で運用する。

## 設計判断

- **Node.js標準機能のみ**: 新規外部ライブラリを追加せず、既存のNode 24と組み込み`fetch`を使う
- **同期API**: MVPは1ユーザー・1画像を前提とし、ジョブ永続化や履歴を持たない
- **画像縮小はブラウザ側**: 大きなスマホ写真の転送量と画像トークン数を抑える
- **保存しない**: Data URL、Buffer、OCR本文はリクエスト中だけ保持する
- **Tailscale前提**: インターネットへポート公開しない。Telegramやクラウド同期も使わない
- **server_manager自動起動**: HTTPサーバーは軽量なため常駐させ、外出先から直接開けるようにする

## セキュリティ上の境界

アプリ独自認証は持たず、Tailscale端末認証をアクセス境界とする。
`0.0.0.0`待受のため同一LANにも公開されるが、ルーターのポート転送は行わない。
より厳密な分離が必要になった場合はTailscale Serveまたはアクセスコードを追加する。
