# local-ocr — Claude 開発方針（L3: この repo 固有）

1. 本 repo の `README.md` / `DESIGN.md` / `CONTEXT.md` を Read（このツールの構造・ハマりどころ）。

## メモ

- モノレポ（my-python-project）から git filter-repo で履歴付き分割した repo。
- 秘密（`auth.json` / `.credentials.json` / `.env`）はコミットしない。
- 稼働（Railway / server_manager / スケジューラ）切替は移行 Phase 3。分割時点では稼働系は無傷。
