# kSQL アクション — オーサリング環境（Claude Code 向けメモ）

このリポジトリは、**kintone プラグイン「kSQL アクション」（rex0220 kSQL Action）の設定を AI が作る**ための tools と MCP（接頭辞 `kact_`）です。
公開（MIT）。有償プラグインのコードは入れません（検査は zip のオーサリング API を読んで呼ぶ）。
計画と決定は `ksql-action/docs/オーサリングMCP_実装計画.md`（本体のリポジトリ。private）にあります。

## 常に守ること

- **kintone への書き込みは行わない。** tools と MCP は GET だけ。取り込みと実行は利用者が画面で行う。
- **有償プラグインのコードをこのリポジトリに入れない。** 検査・計算式エンジンは**利用者の zip から読む**（`src/plugin-zip.ts` → `src/engine.ts`）。
- 接続のファイル（`.env` の `KACT_KINTONE_CONFIG`、MCP の設定項目）と、そこが名前を書いた環境変数は利用者のもの。**読まない・書かない・表示しない**。
- 設定ファイルは**上書きしない**（新規は別名、更新は `expectedDigest` の照合）。作業フォルダーの外に書かない。
- 設定ファイルそのものを Read / head / node で表示しない（1 行の JSON なので全体が出る）。中身は `kact_actions` で見る。
- 設定を作った・変えたら、**最後に必ず反映方法を伝える**: 設定画面で**アップロード → 保存 → 運用環境に反映 → ボタンを押して確かめる**。
- 一覧 ID、権限のユーザー / 組織 / グループのコード、アプリ ID は**推測しない**（利用者に聞く）。

## 版の対応

- `src/meta.ts` の `SUPPORTED_API_VERSIONS` は、本体（`ksql-action/src/authoring/api.ts`）の `AUTHORING_API_VERSION` と対で保つ。
  本体が API の名前や引数を変えて版を上げたら、ここに足して試験を流す。
- `MIN_PLUGIN_VERSION` は、オーサリング API を同梱した最初のプラグインの版（Ver.1）。

## 保存の約束（段階 2）

- 作業フォルダーのファイルを書くのは `src/save.ts` だけ（`kact_save_config` / `kact_update_action` / `kact_pull`）。
  確定とロックは `src/commit-file.ts`（**印刷屋の tools からの写し。あちらが正本**）。新しい書き込みを足すときもここを通す。
- **新規は上書きしない・更新は `expectedDigest`・検査のエラーがあれば書かない**（README の「保存の約束」）。
  この 3 つは試験（`test/save.test.mjs`）で守る。
- 作業フォルダーの外は `denied`。パスの判定は `src/workspace.ts`（読みは `resolveInWorkspace`、書きは `resolveNewInWorkspace`）。

## 資料（`docs/`）

- `kact_docs` が返す章は `docs/manifest.json` の `sections`（key = section の名前）。Markdown を足したら manifest にも足す。
- **正本は本体の `ksql-action/docs/spec.md`**。仕様が変わったら docs/ の該当章を直す（規約・標準形・APPLY・選択の渡し方・計算式）。
- 資料は**ビルドのときに `dist/mcp.mjs` へ埋め込む**（`scripts/build.mjs` の `__KACT_DOCS__`）。
  バンドルしないで動かすときは `docs/` から読むので、`npm test` は `npm run build` の後に流す。
- 開発環境のホスト名・実アプリ ID・業務データの値を資料に書かない（例は架空の名前で書く）。

## 写し元

`src/plugin-zip.ts` / `src/engine.ts` / `src/meta.ts` / `src/paths.ts` / `src/commit-file.ts` / `src/line-diff.ts` / `src/connections.ts` / `src/kintone-rest.ts` / `src/kintone-url.ts` は、**印刷屋のオーサリング tools（`print-craft-authoring/tools`。MIT・同じ作者）から写して直したもの**です（`commit-file.ts` はロックの名前だけ、`line-diff.ts` と `kintone-url.ts` はそのまま）。
zip の読み取り（2 層・zip bomb・CRC の確認）、エンジンの読み込み（happy-dom、`moment` → `moment-timezone` → `bignumber` → `decimal` → 計算式エンジン → オーサリング API の順、`kintone` と `cybozu` のスタブ）、**ファイルの確定とロック**、**接続のファイルの読み取りと GET だけの REST** の作りは向こうが正本です（Codex のレビューを何度も通している）。
直すときは向こうの変更も見る。

## kintone への通信（段階 3）

- 送るのは **GET だけ**。送れるパスは `src/kintone-rest.ts` の `ALLOWED_APIS`（`app` / `apps` / `app/form/fields` / `preview/app/form/fields`）に固定で、**レコードは読まない**。
- 接続は `src/connections.ts`（接続のファイルの profile だけ）。**ファイルの場所・中身・秘密の値は返さない**（返すのはファイル名・profile 名・ホストまで）。
  接続のファイルが**作業フォルダーの中**にあれば `denied`。
- `kact_fields` が置く `fields/<profile>/APP<番号>.json` は**ツールが作る控え**で、設定ファイルではない（取り直すと上書きする）。
  控えがあると `kact_check` と保存のツールが計算式を**項目コードまで**検査する（`summary.formulaCheck` が `fields`）。
  文脈は本体の `loadFormulaContext` に作らせる（検査用レコードの組み立てを写さない）。
