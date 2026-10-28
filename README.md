# kSQL アクション — 設定のオーサリング（tools と MCP）

kintone プラグイン **「kSQL アクション」（rex0220 kSQL Action）** の設定を、AI（Claude）が要望から作り・直すための環境です。
作った設定は、利用者がプラグインの設定画面で **設定をアップロード → 保存 → 運用環境に反映** して使います。

- **AI は kintone に書き込みません。** 読むのは項目定義などの GET だけで、取り込みと実行は必ず人が画面で行います。
- **検査はプラグイン本体と同じコードを使います。** 設定の形・SQL（kSQL の Flow dialect 1）・テーブルへの書き戻し（APPLY）・計算式の検査は、
  **利用者が持っているプラグインの zip に同梱された「オーサリング API」**（`config_js/ksql-action-authoring-api.js`）を読み込んで呼びます。
  このリポジトリに有償プラグインのコードは入っていません。
- 配り方は 2 つ: **Claude Code のプラグイン**（ツール名の接頭辞は `kact_`）と、**Claude Desktop の `.mcpb`**。

## 要るもの

| もの | 置き場所 | 備考 |
|---|---|---|
| kSQL アクションプラグインの zip | 利用者が配布元から入手したもの | `.env` の `KACT_PLUGIN_ZIP`（または MCP の設定項目）で場所を指定 |
| kintone の接続のファイル | 作業フォルダーの外 | kSQL の `ksql.config.json` と同じ形。アプリごとの**閲覧だけ**の API トークン |
| Node | 20 以上 | |

## 使い方（概要）

1. 作業フォルダーを用意し、MCP（または CLI）を登録する。
2. AI に作りたいアクションを伝える（「受注を顧客ごとに集計して、集計アプリのテーブルに書き戻したい」など）。
3. AI が項目定義を読み、SQL と計算式を組み立て、**本体と同じ検査**を通してから設定ファイルを保存する。
4. 利用者が設定画面で取り込み、保存し、運用環境に反映して、ボタンを押して確かめる。

## このリポジトリの中身

| フォルダー | 中身 |
|---|---|
| `src/` | tools の中核（zip の読み取り、エンジンとオーサリング API の読み込み、検査の呼び出し）と MCP サーバー |
| `vendor/` | zip に入っていない moment（プラグインは CDN から読むため、tools は自前で持つ） |
| `docs/` | 手順と資料（`kact_docs` が返すもの。`manifest.json` が章の一覧） |
| `dist/` | `npm run build` が作る MCP サーバー 1 ファイル（`dist/mcp.mjs`） |

## ツール（段階 2 まで）

| ツール | すること | 書き込み |
|---|---|---|
| `kact_docs` | 手順と資料（最初に呼ぶ）。引数なしで目次、`section` で章、`query` で探す | なし |
| `kact_status` | tools の版と、zip（プラグインの版・オーサリング API の版・計算式エンジン）の診断 | なし |
| `kact_workspace_status` | 作業フォルダーの場所と、その直下の JSON の名前 | なし |
| `kact_files` | 作業フォルダーの JSON の一覧（設定ファイルは `digest`・アクションの数・アプリ ID も） | なし |
| `kact_check` | 設定ファイルを**プラグイン本体と同じ規則**で検査（エラーと注意） | なし |
| `kact_actions` | 設定ファイルの中身を 1 アクション 1 行で（SQL 本文は返さない。`digest` 付き） | なし |
| `kact_diff` | 2 つの設定の差（アクション単位。SQL と計算式は変わった行だけ） | なし |
| `kact_save_config` | 新しい設定ファイルを**検査してから**保存（**上書きしない**） | 作業フォルダー |
| `kact_update_action` | アクションを 1 つ差し替える・足す（`expectedDigest` で照合。直した差を `changes` で返す） | 作業フォルダー |
| `kact_delete_action` | アクションを 1 つ消す（`expectedDigest` で照合。最後の 1 件は消せない） | 作業フォルダー |
| `kact_pull` | 設定画面でダウンロードした設定を作業フォルダーに写す（**元は残す**） | 作業フォルダー |
| `kact_fields` | kintone の項目定義を**読み取り（GET）だけ**で取り、控えて要約（コード・型・ラベル・重複禁止・テーブルの子・**SQL で書ける項目か**）を返す。取った後は計算式を**項目コードまで検査**する | kintone（GET）＋ 作業フォルダー |
| `kact_apps` | アプリの一覧（`name` で名前を絞れる。続きはツールが読んで集める。**ログイン名とパスワードの接続のときだけ**） | kintone（GET） |

**kintone には何も書きません。** 書くのは作業フォルダーの中だけで、取り込みと実行は利用者が設定画面で行います。
kintone に送るのは `kact_fields` / `kact_apps` の **GET** だけで、送れるパスは固定しています（`src/kintone-rest.ts` の `ALLOWED_APIS`。レコードは読みません）。

### 保存の約束

- ファイルは**作業フォルダーからの相対パスだけ**（`..`・絶対パス・symlink の先は `denied`）。
- **新規は上書きしない**（同じ名前なら `conflict`）。**更新は `expectedDigest` の照合**（読んだ後に変わっていたら `conflict`）。
- **検査（本体と同じ規則）のエラーがあれば書かない**（`invalid` と findings を返す）。注意（warning）は書いてから伝える。
- 確定は「一時ファイル → ロック → 確かめ直し → 原子的に置く」（`src/commit-file.ts`）。

### 起動の設定（AI の引数では変えられない）

| | |
|---|---|
| `--surface claude-code \| desktop` | 出すツールの出し分け |
| `KACT_PLUGIN_ZIP` | kSQL アクションプラグインの zip の場所 |
| `KACT_WORKSPACE` | 作業フォルダー（省略時は起動したフォルダー） |
| `KACT_KINTONE_CONFIG` | kintone の接続のファイル（kSQL の `ksql.config.json` と同じ形。**作業フォルダーの外**に置く。省略すると `kact_fields` / `kact_apps` は使えない） |

### kintone の接続（`kact_fields` / `kact_apps` だけが使う）

接続のファイルは **kSQL の `ksql.config.json` と同じ形**です（計算式プラグイン・印刷屋のオーサリングと共通）。
**kSQL（kSQL Dashboard Pro など）を使っていれば、その `ksql.config.json` をそのまま使えます。**
無ければ `kintone-connections.example.json` を写して、**作業フォルダーの外**に置いてください（例 `~/kintone-connections.json`）。

```jsonc
{
  "defaultProfile": "dev",
  "profiles": {
    "dev": {
      "baseUrl": "https://example.cybozu.com",
      "tokenMap": { "APP1001": "env:KACT_TOKEN_APP1001" }   // アプリごとの閲覧用 API トークン
    }
  }
}
```

読めているかは **`kact_status`** で分かります（接続のファイルの名前・profile・接続先のホスト・トークンを持つアプリと、それが使える状態かまで。
**パスも秘密の値も出しません**）。設定が無くても、設定ファイルの検査と保存（`kact_check` / `kact_save_config` など）は使えます。

- 読むキーは `defaultProfile` と `profiles.<名前>` の `baseUrl` / `guestSpaceId` / `auth` / `username` / `password` / `passwordEnv` / `tokenMap` だけ（kSQL のほかのキーは読まずに通す）。
- 読む環境変数は、**このファイルが名前を書いた `env:` と `passwordEnv` だけ**。
- **GET だけ**（`app` / `apps` / `app/form/fields` / `preview/app/form/fields`）。レコードは読まない。
- 接続のファイルの**場所も中身も秘密の値も返しません**（返すのはファイル名・profile 名・接続先のホストまで）。

## ライセンス

MIT（`LICENSE`）。zip から読み込む kSQL アクションプラグインと計算式エンジンのコードは**このリポジトリには含まれません**。
