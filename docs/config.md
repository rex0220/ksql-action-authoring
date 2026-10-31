# 設定ファイルの形（封筒・共通設定・アクション）

設定画面の［設定をダウンロード］［設定をアップロード］が読み書きする **1 ファイルの JSON**（封筒形式）です。
`kact_check` はこの形を受けて、**設定画面の保存とまったく同じ規則**で検査します。

## 封筒（外側）

| キー | 値 | 備考 |
|---|---|---|
| `date` | `"2026-10-28 00:00"` | 書き出した日時（表示だけ） |
| `pluginName` | `"kSQL アクション"` | 表示だけ |
| `pluginID` | **`"rex0220 ksql action"`** | **これが合わないと取り込めない**（固定の識別子。kintone のプラグイン ID とは別） |
| `PluginVersion` | `"1"` | 書き出したプラグインの版 |
| `appId` / `appName` | `1001` / `"受注"` | 書き出した元のアプリ（表示だけ。別のアプリに取り込める） |

封筒の**同じ階層に設定本体のキーを並べます**（入れ子にしない）。

## 共通設定

| キー | 型 | 内容 |
|---|---|---|
| `configVersion` | `1` | 固定 |
| `bindings` | `[{ name, appId }]` | **論理アプリの対応表**。SQL では `LAPP_<name>` で参照する。自アプリも登録する。**自アプリと同じ領域のアプリだけ** |
| `logApp` | `{ appId, guestSpaceId, profile }`（任意） | 任意のログアプリ。**無ければ記録もロックもしない**（別ユーザーの二重実行は防げない） |
| `limits` | 下の表 | 制限 |
| `timezone` | `""` | as-of 関数（`@NOW()` / `@TODAY()`）の基準。空 = アプリの設定に従う |
| `panel` | `{ title, sections, views }` | 一覧画面の**区分とパネル**（下の「一覧パネル（`panel`）」） |
| `progressStyle` | `"dialog"` / `"spinner"` | イベント実行中の見せ方（既定 `dialog`） |
| `actions` | `[ActionDef]` | アクションの列。**並びがボタンを出す順**（同じイベントの実行順も同じ） |
| `pluginComment` / `pluginDescription` | 文字列（任意） | 設定する人の覚え書き。利用者の画面には出ない |

### `limits`

| キー | 既定 | 内容 |
|---|---|---|
| `readMax` | 10000 | 読み取りの合計件数（1 コンテキストごと） |
| `tempTableMax` / `tempTotalMax` | 10000 / 20000 | 一時テーブルの行数 |
| `timeoutMin` | 60 | 実行タイムアウト（分。起動 1 回） |
| `apiTimeoutSec` | 60 | API 通信のタイムアウト（秒） |
| `listBulkMax` | 300 | 一覧の選択の上限（「まとめて 1 回」は min(これ, 200)） |
| `applySubtableMax` | 500 | **APPLY で変わる子行の上限**（1 文。`REMOVE ALL ROWS` で消える既存行も数える） |

**`kact_save_config` は足りないキーを本体の既定値で埋めます**（`configVersion` / `limits` / アクションの各キー）。変えるところだけ渡してください。

## アクション（`actions` の 1 要素）

```json
{
  "enabled": true,
  "code": "mark",
  "name": "印を付ける",
  "description": "",
  "type": "record",
  "onList": false,
  "placements": ["detail_menu"],
  "panelSection": "",
  "showCond": "",
  "execCond": "",
  "execNgMessage": "",
  "params": [{ "name": "cust", "source": "formula", "formula": "顧客コード" }],
  "inputs": [],
  "sql": "-- @ksql dialect: 1\nDECLARE @cust = '';\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 顧客コード = @cust;",
  "staticInsertRows": 0,
  "confirm": true,
  "writeLimit": 0,
  "refreshPrompt": "auto",
  "allowed": [],
  "allowAll": true,
  "resultMessage": "",
  "listOnError": "continue",
  "selectionMode": "loop",
  "groupFormula": "",
  "perRecordLock": false,
  "prevRecord": false
}
```

| キー | 値 | 備考 |
|---|---|---|
| `enabled` | 真偽 | 無効なら起動口を出さずイベントにも反応しない。**無効の行は SQL を検査しない**（下書き） |
| `code` | `[A-Za-z_][A-Za-z0-9_]*`、32 字まで | 大文字小文字を無視して一意。ロックキーとログに使う。**あとで変えない** |
| `name` / `description` | 文字列 | ボタン・パネルに出す |
| `type` | `"record"` / `"app"` | レコード 1 件に実行 / レコードに依らない処理（**2026-10-31 に 3 つから 2 つになった**。旧 `"list"` は `"record"` ＋ `onList: true` に読み替わる） |
| `onList` | 真偽 | **一覧画面でも使う**（選んだレコードに実行）。`type: "record"` のときだけ |
| `placements` | 下の表 | 詳細画面の出し場所（複数可）とイベント。**一覧画面の出し方はここでは決めない** |
| `panelSection` | 文字列 | 一覧パネルの**区分の名称**（空 = 区分なし）。`panel.sections` で定義した名前だけ |
| `showCond` | 計算式 | 偽ならボタンを出さない（イベント起動には効かない） |
| `execCond` / `execNgMessage` | 計算式 | 偽なら実行せずメッセージ |
| `params` | `[{ name, source, formula }]` | SQL の `DECLARE` と**過不足なく 1 対 1**（下の「パラメーターと入力項目」） |
| `inputs` | `[{ name, label, type, required, defaultFormula, options }]` | 実行時に聞く値。`type` は `text` / `number` / `date` / `datetime` / `select` / `relative_date`。**イベント起動には持てない** |
| `sql` | Flow dialect 1 | 1 本 20,000 字・20 文まで（`sql`） |
| `staticInsertRows` | 整数 | 素の `INSERT … VALUES` の行数。**保存のときにプラグインが数え直して上書きする**ので、AI は書かなくてよい |
| `confirm` | 真偽 | 既定 `true`（件数の確認）。`false` にすると `writeLimit` が**必須** |
| `writeLimit` | 整数（0 = 無し） | 起動 1 回で書いてよい合計件数 |
| `allowed` | `[{ type, code, name? }]` | `type` は `USER` / `GROUP` / `ORGANIZATION`。空 = 全員。**誤操作防止**で、セキュリティ境界ではない |
| `allowAll` | 真偽 | `true` なら `allowed` を見ずに全員（`allowed` は消さずに残す）。既定 `true` |
| `refreshPrompt` | `"auto"` / `"always"` / `"never"` | 完了のダイアログに［この画面を更新］を出すか。`auto` = このアプリに書いたときだけ |
| `resultMessage` | 計算式 | `_result_*` が使える（`formula`）。空 = 既定の文 |
| `listOnError` | `"continue"` / `"stop"` | 一覧の 1 件ずつのときだけ効く |
| `selectionMode` | `"loop"` / `"once"` / `"group"` | 一覧で選んだレコードの渡し方（`selection`）。**`onList: true` のときだけ効く** |
| `groupFormula` | 計算式 | `selectionMode: "group"` の**分ける式** |
| `perRecordLock` | 真偽 | ログアプリ指定時のみ。ロックキーにレコード ID を足す |
| `prevRecord` | 真偽 | 起動に `event_edit` があるときだけ。集計先が変わったときに**前の集計先も**直す |

### `placements`

| 値 | 場所 | 使える種類 |
|---|---|---|
| `detail_menu` | 詳細画面のヘッダー | record |
| `detail_space` | 詳細画面のスペース項目 | record |
| `event_create` | 保存後（追加） | record のみ |
| `event_edit` | 保存後（編集。一覧のインライン編集を含む） | record のみ |
| `event_status` | ステータス変更（遷移が確定した後の詳細画面で実行） | record のみ |

**一覧画面に出す道**（2026-10-31 に `index_menu` / `index_panel` をやめた）: アクション側は `onList`（種類 record）か
種類 `app` で「一覧画面に出る」ことだけを決め、**どの一覧にどう出すか（パネル / メニュー / 出さない）は共通設定の `panel`** で決めます。

### 一覧パネル（`panel`）

```json
{
  "title": "",
  "sections": [{ "enabled": true, "name": "受注", "color": "blue", "tone": "soft", "collapsed": false }],
  "views": [{ "viewId": "*", "sections": ["受注"], "menus": [], "open": false }]
}
```

| キー | 値 | 備考 |
|---|---|---|
| `title` | 文字列 | パネルの帯の名前（空 = プラグイン名） |
| `sections` | `[{ enabled, name, color, tone, collapsed }]` | **区分の定義**。`name` がキー（アクションの `panelSection` と突き合わせる）。`color` は 8 色 ＋ `""`、`tone` は `"soft"` / `"vivid"`、`collapsed` は既定で畳むか。**無効（`enabled: false`）の区分は定義していないのと同じ** |
| `views` | `[{ viewId, sections, menus, open }]` | **一覧ごとの出し方**。`viewId` が `"*"` の行は「ほかの一覧すべて」（必ず 1 行目）。`sections` = パネルに出す区分、`menus` = メニューに出す区分（メニュー名は区分名。区分なしはボタンを直接並べる）、`open` = パネルを開いて出すか |

**一覧 ID は推測せず利用者に聞く**（`"*"` の行だけで済むなら足さない）。区分の名前を変えるときは、アクションの `panelSection` も一緒に変えます。

**イベント起動の決まり**: 確認なし（`confirm: false`）＋ `writeLimit` 必須 ＋ `inputs` なし ＋ `showCond` は効かない。
イベントは**ブラウザーの操作だけ**で動きます（REST API・CSV 読み込みでは動かない）。

## パラメーターと入力項目

SQL の `DECLARE` 1 本につき **`params` の行が 1 つ**要ります（予約名 `_record` / `_selected` / `_group` などは除く。`sql`）。
値の出どころが `params[].source` で、**実行時に聞く値（`"input"`）のときは `inputs` にも同じ名前の行**が要ります
（**`params` だけ・`inputs` だけでは足りません**。`inputs` だけだと `pParamMissing`、`params` だけだと `pInputMissing`）。

```jsonc
// DECLARE @cust（レコードの値）と DECLARE @memo（実行時に聞く値）の 2 本があるとき
"params": [
  { "name": "cust", "source": "formula", "formula": "顧客コード" },  // 計算式で決める
  { "name": "memo", "source": "input" }                              // 実行時に聞く → inputs にも要る
],
"inputs": [
  { "name": "memo", "label": "処理メモ", "required": true }
]
```

- `source: "input"` の行に `formula` は要りません（空で埋まります）。
- `inputs` の `label` / `type` / `required` / `defaultFormula` / `options` は**書かなければ既定で埋まります**
  （`label` は名前、`type` は `text`、`required` は `false`、`options` は `[]`）。
- `options` を書くのは `type` が **`select`** か **`relative_date`** のときだけです。どちらも**選択肢**として出るので、
  空のままだと利用者は何も選べません（`relative_date` では、許す日付関数のトークンを並べます）。
- `type: "relative_date"` の入力項目と対になる `DECLARE` は、`RELATIVE_DATE` 注釈つきで書きます（`sql`）。

## 容量

kintone のプラグイン設定の上限は**合計 256 KB**（圧縮して保存）。苦しくなったらアプリを分けて運用します。
