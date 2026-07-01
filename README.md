# local_ocr

スマホで撮影・選択した画像を、自宅PCのOllamaとローカルビジョンモデルでOCRするWebツール。
画像と抽出テキストはサーバーへ永続保存せず、外部AI APIも使用しない。

## スマホから使う

前提:

- 自宅PCが起動中でスリープしていない
- スマホと自宅PCの両方でTailscaleが接続済み
- 自宅PCでOllamaが起動し、`qwen3.5:9b`がインストール済み
- `server_manager`が起動済み

スマホで次を開く。

```text
http://100.78.223.50:8005
```

1. 「カメラで撮る」または「画像を選ぶ」
2. プレビューを確認して「文字を抽出する」
3. 結果を必要に応じて修正し、「コピー」または「TXT保存」

処理中は画面を閉じずに待つ。通常の書類より、縦長画面や文字量の多い画像は時間がかかる。

## 対応範囲

- ブラウザで開ける画像を送信前にJPEGへ変換
- 元画像は20MBまで
- 長辺3,000pxを超える画像はスマホ側で縮小
- 日本語・英数字の印刷文字
- 1回につき1画像
- 同時OCRは1件
- タイムアウトは360秒

HEICはスマホブラウザが画像を開ける場合のみ利用できる。手書き、表、低照度、強い傾き、
小さな文字は誤認識することがあるため、重要な日付・金額・固有名詞は元画像と照合する。

## 起動と確認

通常は`server_manager`が自動起動する。手動起動:

```powershell
node tools/local_ocr/server.mjs serve --host 0.0.0.0 --port 8005 --no-browser
```

環境診断:

```powershell
node tools/local_ocr/server.mjs doctor
```

テスト:

```powershell
node --test tests/test_local_ocr.mjs
```

## 環境変数

| 変数 | 既定値 | 内容 |
|---|---:|---|
| `LOCAL_OCR_HOST` | `127.0.0.1` | 待受ホスト |
| `LOCAL_OCR_PORT` / `PORT` | `8005` | 待受ポート |
| `LOCAL_OCR_MODEL` | `qwen3.5:9b` | Ollamaモデル |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama API |
| `LOCAL_OCR_TIMEOUT_MS` | `360000` | 推論タイムアウト |
| `LOCAL_OCR_MAX_IMAGE_BYTES` | `20971520` | デコード後画像上限 |
| `LOCAL_OCR_MAX_REQUEST_BYTES` | `29360128` | JSONリクエスト上限 |

## セキュリティ

- ルーターのポート開放は行わない
- Tailscale経由でのみ利用する
- server_manager登録時は`0.0.0.0`で待ち受けるため、同一LANからも到達可能
- OCR画像・OCR本文・ファイル名はログへ記録しない
- ログにはモデル名、画像バイト数、処理時間、成否のみを記録する
