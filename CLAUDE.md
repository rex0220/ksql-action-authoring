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
- 設定を作った・変えたら、**最後に必ず反映方法を伝える**: 設定画面で**アップロード → 取り込み方を選ぶ → 保存 → 運用環境に反映 → ボタンを押して確かめる**。
  取り込み方は **全置換 / 一部置換 / 追加**（ツールが作るのは設定全体のファイルなので、通常は全置換。`docs/deploy.md`）。
- 一覧 ID、権限のユーザー / 組織 / グループのコード、アプリ ID は**推測しない**（利用者に聞く）。

## 版の対応

- `src/meta.ts` の `SUPPORTED_API_VERSIONS` は、本体（`ksql-action/src/authoring/api.ts`）の `AUTHORING_API_VERSION` と対で保つ。
  本体が API の名前や引数を変えて版を上げたら、ここに足して試験を流す（今は **[1, 2, 3, 4, 5, 6, 7, 8]**。版 2 = 封筒を migrate してから検証する `parseConfigFile`、版 3 = 実行計画の `explainActionSql` と、控えだけで動く `createFieldsClient`、版 4 = 計算式の**評価**（`evalFormula` / `evalCondition` / `toParamValue` / `withResultRecord`。`kact_try` が使う）、版 5 = `hasLoop`、版 6 = 結果の変数が `$result_*` に変わった（口は同じ）、版 7 = **共通の文（`messages`）と多言語**〈`checkActionSql` に `options.messages` が要る〉、版 8 = **選択肢の「言語ごとの表示名」への逆向きの検査**〈`sqlChoiceLiterals` と、`checkActionSql` の返りの `choiceUnknown`。**控えから作る client（`createFieldsClient`）を渡したときだけ埋まる**〉）。
  **古い版の zip も動かす**（`requiredApiFor` は版ごとに要るキーを変え、足した口を使うツールだけが「zip が古い」と断る）。
  **埋め込む meta（`scripts/build.mjs` の `__KACT_TOOLS_META__`）は `src/meta.ts` から読む**。書き写すと食い違う
  （2026-10-31 に `supportedApiVersions: [1]` が残っていて、版 2 の zip を MCP が拒んだ）。
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

## 配布（段階 5）

- 配るのは **Claude Desktop の `.mcpb`** と **Claude Code のプラグイン**（marketplace `rex0220-ksql-action`）の 2 つ。**npm には公開しない**（本体を束ねてあるので中核のパッケージが要らない）。手順は `docs/リリース手順.md`。
- 配布のしくみは **formula MCP（`formula-authoring-mcp`）からの写し**で、**あちらが正本**（`scripts/zip.mjs`・`forbidden-files.mjs`・`third-party-notices.mjs`・`mcpb-verify.mjs`・`plugin-zip-verify.mjs`・`write-marketplace.mjs`・`build-mcpb.mjs`・`hooks/`）。直すときは向こうの変更も見る。
- 版は **`package.json`・`.claude-plugin/plugin.json`・`compat.json` の 3 か所を同じに**する（`scripts/build.mjs` と `test/release.test.mjs` が食い違いで止める）。`compat.json` の `authoringApiVersions` と `pluginVersion.min` の正本は `src/meta.ts`。
- **配布物は同じコミットから作れば同じバイト列**（埋め込む日時は**コミットの日時**。`builtAt` にビルドの時刻を入れない。marketplace が sha256 で固定するため）。
- `THIRD_PARTY_NOTICES.md` はビルドが作る。手で直さない（依存を変えたら `npm run notices` → 差分を見てコミット）。
- 作業の成果物（`dist/`・`dist-mcpb/`・`dist-plugin/`・`.tmp/`）と、`fields/`・`inbox/`・`settings/` はコミットしない（`.gitignore`。`test/release.test.mjs` がリポジトリを検査する）。
- `hooks/` のフックは**直接の書き込みを止めるだけ**（`settings/**/*.json`・`fields/**`・`inbox/**`）。formula のような作業フォルダーの登録（`workspaceId` の書き換え）は入れていない（kact のツールは作業フォルダーを引数で受けないため）。
  フックは **fail-closed**（セッションのフォルダーが解決できなければ書き込みを断る）なので、直したら `claude plugin test .`（`hooks/register.test.ts`。6 件）を流す。
- `.claude-plugin/types/` は `claude-code` の型（git に入れない。formula MCP の同じフォルダーから写せる）。`hooks/tsconfig.json` がそれを見る。

## 写し元

`src/plugin-zip.ts` / `src/engine.ts` / `src/meta.ts` / `src/paths.ts` / `src/commit-file.ts` / `src/line-diff.ts` / `src/connections.ts` / `src/kintone-rest.ts` / `src/kintone-url.ts` は、**印刷屋のオーサリング tools（`print-craft-authoring/tools`。MIT・同じ作者）から写して直したもの**です（`commit-file.ts` はロックの名前だけ、`line-diff.ts` と `kintone-url.ts` はそのまま）。
zip の読み取り（2 層・zip bomb・CRC の確認）、エンジンの読み込み（happy-dom、`moment` → `moment-timezone` → `bignumber` → `decimal` → 計算式エンジン → オーサリング API の順、`kintone` と `cybozu` のスタブ）、**ファイルの確定とロック**、**接続のファイルの読み取りと GET だけの REST** の作りは向こうが正本です（Codex のレビューを何度も通している）。
直すときは向こうの変更も見る。

## 設定画面だけの検査を「同じ規則」と書かない

tools は **GET だけ**なので、設定画面の［保存する］と**まったく同じ規則にはならない**
（2026-11-07 の Codex レビュー #8。資料が「設定画面の保存とまったく同じ規則」と書いていた）。
書き込みを伴う検査は本体にしかできないので、**できる分だけ見て、見ていない分を findings で言う**:

| 設定画面だけの検査 | tools の代わり |
|---|---|
| **ログアプリへの試し書き**（`connection-test.ts`。項目の型・読み書きの権限・`job_key` の重複禁止） | `log-app-unverified`（警告）。自アプリ指定（`log-app-self`）と領域の食い違い（`log-app-area`）だけは控えで見る |
| **論理アプリの存在**（`checkBindingArea` の `pBindingMissing`） | 控えがあるアプリの**領域**だけ突き合わせる（`binding-area`。控えに無ければ `binding-area-unknown`） |

領域の突き合わせの鍵は **`host`**（`profile` ではない）。接続のファイルの profile は
**ホストとゲストスペースの組**なので、ゲストスペースのアプリは必ず別の profile になる。
profile で弾くと、**設定画面がいちばん止めたい形**（通常領域の画面からゲストスペースのアプリを選ぶ）が
まるごと「比べられない」に落ちる（0.11.2 でそうなっていて、0.11.3 で直した。実機で通して見つけた）。

**黙って飛ばさない**のが決まり（findings が空だと AI は「検査して問題なし」と読む）。
新しく「本体だけができる検査」が増えたら、この表と `docs/config.md` の冒頭の表を両方直す。

## 計算式の検査は、本体の設定画面と 1 対 1 に保つ

`src/core.ts` の `formulaSlots` / `checkFormulas` は、**本体の `ksql-action/src/config/dialogs.ts` の
`push(…)` の並びと同じ**でなければならない（**どの口を・どの文脈で・どんな条件のときに見るか**の 3 つとも）。
ここがずれると、**設定画面では保存できる設定を tools だけが拒む**（またはその逆）。
2026-11-07 の試用と洗い出しで、このずれが **5 件**見つかった:

| ずれていたもの | 症状 |
|---|---|
| `loadFormulaContext` に `messages` を渡していない | 共通の文を使う設定が**ひとつも保存できない** |
| `execNgMessage` / `optionLabelsFormula` が `message(base)` でない | 同上 |
| `result(base)` に**ループかどうかを渡していない** | `$result_runs` ほかが「無い項目」になる |
| `groupFormula` を条件なしで見る | 渡し方を変えた後の**残りかす**が保存を止める |
| `loop` を条件なしで見る | 同上 |

**守り方**:

- 文脈は**本体の口に決めさせる**（`loadFormulaContext` の返りの `record` / `none` / `result(base, loop)` /
  `loopParam(base)` / `message(base)`）。tools で組み立てない。
- 「見るかどうか」の条件も**本体の口で判定する**（`hasLoop` / `isSelectionGrouped` / `input.type === "select"`）。
  **「残っているだけで効かない式」は見ない**のが本体の方針（`dialogs.ts` の注記）。
  **S6 のとおりエラーが 1 つあると `kact_update_action` は何も書けなくなる**ので、
  厳しすぎる検査はそれだけで設定を編集不能にする。
- 口を足す・文脈を変えたら、**`test/core.test.mjs` に「その口が通る形」と「通らない形」を 1 組**足す。

## 式の試し計算（`kact_try`）

- 評価は**本体の API（版 4）に任せる**（`evalFormula` / `evalCondition` / `toParamValue` / `withResultRecord`。
  実行時の `ksql-action/src/desktop/formula-run.ts` をそのまま公開したもの）。
  **真偽の判定（`"0"` / `"false"` / 空は偽）と数値の文字列化を tools に写さない**。写すと本物とずれ、
  `kact_try` で確かめたい動きそのものが嘘になる（2026-11-03。選択式ルックアップテーブル Ver.15 の退行と同じ罠）。
- 文脈（`pp` / `crec`）は本体の `loadFormulaContext` が作る（`core.ts` の `contextsFrom`）。**値だけ**を `src/try.ts` が差し込む。
- **口ごとの文脈は `kact_check` と同じ `contextForSlot`（`core.ts`）を呼ぶ**（2026-11-07。Codex レビュー #4）。
  `src/try.ts` に「どの口で何が使えるか」の表を 2 つめ作らない。作ると
  **`kact_try` では通るのに `kact_check` が拒む**式（またはその逆）ができる。
  値を差し込むのも**その文脈に擬似項目があるものだけ**（`withResultRecord` は何でも足せてしまう）。
- **共通の文（`$m_…`）の値は本体の口で作る**: `messageValues`（版 7）＋ `withResultRecord`（版 4）。
  実行時の `withMessageRecord` の中身がこの 2 つなので、**版を上げずに同じ値になる**。文も判定も写さない。
- `src/kintone-global.d.ts` は、本体の `formula-run.ts` が使う `kintone` グローバルの**型の解決のためだけ**に置いてある
  （tools は `kintone` を呼ばない。評価の関数は `pp` と `record` を引数で受ける）。

## 実行計画（段階 4）

- `kact_explain` は **kintone に行かない**。本体の `createFieldsClient`（版 3）に控えの `properties` を渡し、
  その client を `explainActionSql` に渡す。client の fetch は手元にあり、`app/form/fields.json` 以外は投げない（レコードは読まない）。
- 控え（`kact_fields`）が無いアプリがあるとエンジンが止まるので、その番号を findings で知らせる。
- 計画の文字に出る `APP9000000xx` はエンジンが付ける内部の名前（実アプリ番号ではない）。

## kintone への通信（段階 3）

- 送るのは **GET だけ**。送れるパスは `src/kintone-rest.ts` の `ALLOWED_APIS`（`app` / `apps` / `app/form/fields` / `preview/app/form/fields` / `app/views` / `preview/app/views`）に固定で、**レコードは読まない**。
- `kact_views`（一覧の ID）は、**「(すべて)」が `views.json` に返らない**ので `viewId: "20"` の行を末尾に足す。
  本体の設定画面（`ksql-action/src/config/views.ts` の `ALL_VIEW_ID`）と同じ作りで、**あちらが正本**。
- 接続は `src/connections.ts`（接続のファイルの profile だけ）。**ファイルの場所・中身・秘密の値は返さない**（返すのはファイル名・profile 名・ホストまで）。
  接続のファイルが**作業フォルダーの中**にあれば `denied`。
- `kact_fields` が置く `fields/<profile>/APP<番号>.json` は**ツールが作る控え**で、設定ファイルではない（取り直すと上書きする）。
  **動作テスト環境は `APP<番号>-preview.json`** と別のファイルにする（同じ名前にしていたので、
  `preview: true` で取ると運用環境の控えを黙って上書きしていた。2026-11-07 の Codex レビュー）。
  `findFieldsFile` は**運用環境を先に見て**、同じアプリ番号の控えがほかにもあれば `others` で返す
  （**接続先が違えば同じアプリ番号は別のアプリ**。黙って新しいほうを選ばない）。
  控えがあると `kact_check` と保存のツールが計算式を**項目コードまで**検査する（`summary.formulaCheck` が `fields`）。
  文脈は本体の `loadFormulaContext` に作らせる（検査用レコードの組み立てを写さない）。
