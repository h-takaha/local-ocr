# local_ocr

## Android のホーム画面から開く

Tailscale Serve などで、このアプリを同じ origin の HTTPS URL として配信し、Android の Chrome で開いて認証します。
ブラウザの「アプリをインストール」または「ホーム画面に追加」から登録すると、独立したウィンドウで開けます。
PC の起動と Tailscale 接続が必要です。オフライン保存・Service Worker は使用しません。
HTTP の Tailscale IP URL はインストール用 HTTPS URL の代わりにはなりません。
HTTPS 配信設定、稼働版への反映、Android 実機でのインストール・再起動確認は別途必要です。

スマホで撮影・選択した画像を、自宅PCのOllamaとローカルビジョンモデルでOCRするWebツール。
画像と抽出テキストはサーバーへ永続保存せず、外部AI APIも使用しない。

## Basic 認証

Server Manager から起動する Web UI（port 8005）は Basic 認証必須です。リポジトリ根の
`.env` に `BASIC_AUTH_USER`（空なら `admin`）と `BASIC_AUTH_PASSWORD` を設定してください。
パスワード未設定時は `/healthz` 以外を 401 にするため、認証なしで画像を送信できません。

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
2. 「通常」または「高精度」の読み取りモードを選ぶ
3. プレビューを確認して「文字を抽出する」
4. 結果を必要に応じて修正し、「コピー」または「TXT保存」

処理中は画面を閉じずに待つ。通常の書類より、縦長画面や文字量の多い画像は時間がかかる。

## 対応範囲

- ブラウザで開ける画像を送信前にJPEGへ変換
- 元画像は20MBまで
- 長辺3,000pxを超える画像はスマホ側で縮小
- 日本語・英数字の印刷文字
- 1回につき1画像
- 同時OCRは1件
- タイムアウトは360秒
- 通常モードは写真の色を維持
- 高精度モードは白黒化、コントラスト補正、軽いシャープ化を適用

HEICはスマホブラウザが画像を開ける場合のみ利用できる。手書き、表、低照度、強い傾き、
小さな文字は誤認識することがあるため、重要な日付・金額・固有名詞は元画像と照合する。

## 読み取りモード

- **通常**（既定）: 写真の色情報を残して長辺最大3,000pxへ変換する
- **高精度**: ブラウザ内でグレースケール化、上下1%を除いたオートコントラスト、
  軽い輪郭強調を適用する。小さい画像は最大3倍まで拡大し、長辺3,000pxを上限とする

影、薄い文字、裏写り、低コントラストの書類では高精度モードが有効な場合がある。
一方、色分けされた表やカラー文字では通常モードの方がよい場合があるため、
プレビューを確認して切り替える。モード変更時は選択済み画像をブラウザ内で再変換する。

画像補正とJPEG変換はスマホのブラウザ内だけで行い、補正前後の画像はディスクへ保存しない。

## 起動と確認

通常は`server_manager`が自動起動する。手動起動:

```powershell
node server.mjs serve --host 0.0.0.0 --port 8005 --no-browser
```

環境診断:

```powershell
node server.mjs doctor
```

テスト:

```powershell
node --test
```

## 環境変数

| 変数 | 既定値 | 内容 |
|---|---:|---|
| `LOCAL_OCR_HOST` | `127.0.0.1` | 待受ホスト |
| `LOCAL_OCR_PORT` / `PORT` | `8005` | 待受ポート |
| `LOCAL_OCR_MODEL` | `qwen3.5:9b` | Ollamaモデル |
| `LOCAL_LLM_DISPATCHER_URL` | `http://127.0.0.1:11435` | 優先して使う単一LLMディスパッチャURL |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11435` | 旧互換の接続先上書き。`LOCAL_LLM_DISPATCHER_URL`未設定時だけ使用 |
| `LOCAL_OCR_TIMEOUT_MS` | `360000` | 推論タイムアウト |
| `LOCAL_OCR_MAX_IMAGE_BYTES` | `20971520` | デコード後画像上限 |
| `LOCAL_OCR_MAX_REQUEST_BYTES` | `29360128` | JSONリクエスト上限 |

## セキュリティ

- ルーターのポート開放は行わない
- Tailscale経由でのみ利用する
- server_manager登録時は`0.0.0.0`で待ち受けるため、同一LANからも到達可能
- OCR画像・OCR本文・ファイル名はログへ記録しない
- ログにはモデル名、画像バイト数、処理時間、成否のみを記録する
## Storage and standalone layout

This server resolves bundled static files from the directory containing `server.mjs`,
not from the process working directory.

- OCR images, temporary data, and extracted text exist only in request memory.
- Ollama owns model storage; this tool neither stores nor moves models.
- The browser's TXT download is written on the client device, never by the server.

If server-side persistent data is added in the future, its default must be an
ignored directory inside this repository. An outside-repository location must be
selected explicitly with an environment variable or command-line argument.
