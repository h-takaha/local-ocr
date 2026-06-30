# local_ocr — 開発コンテキスト
最終更新: 2026-06-30

## 現在の状態

Phase 1 MVP実装・実機検証・ローカル配備完了。mainへ反映済みで、server_managerから
`local_ocr`を起動中。Tailscale経由の`http://100.78.223.50:8005`で利用できる。

スマホのWeb UIから画像を撮影・選択し、自宅PCのOllama `qwen3-vl:8b`でOCRする。
画像と結果は永続保存せず、外部AI APIも使用しない。

## 開発フェーズ

| Phase | 状態 | 内容 |
|---|---|---|
| Phase 1 | 完了 | 1画像OCR、スマホUI、Tailscale運用、doctor、server_manager登録 |
| Phase 2 | 未着手 | 実スマホ・モバイル回線での運用確認 |
| 将来候補 | 未着手 | 複数画像、履歴、表形式出力、Tailscale Serve |

## 開発経緯・設計判断

- Claudeの使用量制限中のため、ユーザーの明示指示を受けてCodexが仕様確定から直接実装した
- メイン作業ディレクトリを`main`のまま維持し、`C:/git/worktrees/local-ocr`
  （`codex/local-ocr`）で作業した
- 外部ライブラリを追加せず、Node.js 24の標準HTTP・fetch・test機能で実装
- 既存の日本語OCR実績がある`qwen3-vl:8b`を固定モデルにした
- 8GB VRAMを競合させないため同時処理は1件
- スマホ側で長辺3,000px・JPEG品質0.92へ変換し、転送量と画像トークンを抑える
- APIは同期式。画像・OCR結果・履歴をディスクへ保存しない
- server_managerへport 8005・`auto_start: true`で登録

## 既知の注意点・ハマりポイント

- 自宅PCが起動中かつスリープしていなければ外出先から利用できない。遠隔起動は対象外
- `qwen3-vl:8b`の既定context 4,096では実画像が4,117 tokensとなり処理前に失敗した。
  Ollama payloadで`num_ctx: 8192`を必ず指定する
- 文字量の多い約1MBの新聞サイト全画面PNGは実機で約199秒。通常の写真より大幅に長い
- server_managerは`0.0.0.0`で起動するため、Tailscaleだけでなく同一LANからも到達可能
- HEIC可否はスマホブラウザのデコード対応に依存する。開けない場合はJPEGで撮影・変換する
- OCRは誤読し得る。重要な日付、金額、固有名詞は元画像との照合が必要

## 最近の変更履歴

- `2026-06-30` mainへ反映し、server_manager APIから起動。localhostと
  Tailscale IPのトップ画面・`/api/health`がHTTP 200になることを確認
- `2026-06-30` Phase 1 MVPを新規実装（`server.mjs`, `static/index.html`,
  `tests/test_local_ocr.mjs`）。server_manager登録、doctor、実Ollama OCRまで検証
