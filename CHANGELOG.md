# 変更履歴

kact（Claude Desktop の拡張機能「kSQL アクション 設定オーサリング」と、Claude Code のプラグイン `ksql-action`）の、利用者に見える変更です。新しい版が上です。

## 0.1.0（2026-11-03）

はじめての版。kSQL アクションプラグイン（rex0220 kSQL Action）Ver.1 以降の設定を作る 14 のツール。

- 手順と資料: `kact_docs`（11 章。規約・標準形・SQL・計算式・選択の渡し方・取り込み方）
- 診断: `kact_status`（zip の版・authoring API の版・接続の profile）、`kact_workspace_status`（作業フォルダーの設定ファイルと項目定義の控え）
- 検査と見積もり: `kact_check`（プラグイン本体と同じ規則。項目定義の控えがあれば計算式を項目コードまで）、`kact_explain`（実行計画。kintone には行かない）
- 設定を作る・直す: `kact_save_config`（上書きしない）、`kact_update_action` / `kact_delete_action`（digest の照合）、`kact_pull`（ダウンロードした設定を取り込む）、`kact_actions` / `kact_files` / `kact_diff`
- kintone（GET だけ）: `kact_fields`（項目定義を取って控えを置く）、`kact_apps`（アプリの一覧）
- Claude Code のプラグインのフック: AI が `settings/**/*.json`・`fields/**`・`inbox/**` を直接 Write / Edit するのを止める
- 配布: Claude Desktop の `.mcpb` と、Claude Code のプラグイン（marketplace `rex0220-ksql-action`）
