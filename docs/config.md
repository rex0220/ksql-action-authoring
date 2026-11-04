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
| `event_create` | 保存後（追加） | record のみ |
| `event_edit` | 保存後（編集。一覧のインライン編集を含む） | record のみ |
| `event_status` | ステータス変更（遷移が確定した後の詳細画面で実行） | record のみ |
| `event_delete` | **削除したあと**（削除する前に控えを取り、削除が成功してから実行） | record のみ |

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

**`"*"` の行だけで済むなら、一覧ごとの行は足しません。** 一覧ごとの行は「**この一覧だけ別扱い**」のためにあります
（例: ある一覧ではパネルではなくメニューに出す、ある一覧では出さない）。

一覧 ID は **`kact_views`** で読めます（番号は推測しない）。**どの一覧を別扱いにするかは利用者に確かめます**。

> **「(すべて)」は API に返りません。** kintone の作りつけの「(すべて)」は `views.json` に含まれないので、
> `kact_views` が `viewId: "20"` の行を**末尾に足して**返します（本体の設定画面と同じ作り）。
> 「(すべて)」でだけ出し方を変えたいときは、この `"20"` を書きます。
> また、**同じ名前の一覧があると kintone は一覧の設定を返しません**（REST の制限）。

ある一覧でだけ出さない例（既定はパネルに出し、一覧 `1102` では出さない）:

```json
"views": [
  { "viewId": "*",    "sections": ["受注"], "menus": [], "open": false },
  { "viewId": "1102", "sections": [],       "menus": [], "open": false }
]
```

区分の名前を変えるときは、アクションの `panelSection` も一緒に変えます。

**イベント起動の決まり**: 確認なし（`confirm: false`）＋ `writeLimit` 必須 ＋ `inputs` なし ＋ `showCond` は効かない。
イベントは**ブラウザーの操作だけ**で動きます（REST API・CSV 読み込みでは動かない）。
`event_delete` も画面から消したときだけ動きます。**削除は非推奨**で、アプリに「削除フラグ」を持たせて集計から外す形を勧めます。

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

### キーの配列（`source: "keys"`）

**その起動で関係するレコードすべて**に式を当て、重複と空を落として**配列**で渡します。
キーの項目（顧客コードなど）を直したとき・レコードを消したときに、**新旧のキーを 1 回の実行でまとめて**渡すための源泉です。

| 起動 | 配列の中身 |
|---|---|
| ボタン・一覧の 1 件ずつ | `[そのレコード]` |
| 一覧の「まとめて 1 回」「グループごと」 | 選んだレコード全部 |
| `event_create` | `[新しい値]` |
| `event_edit` | `[変更後, 変更前]`（控えがあるとき。同じなら 1 件） |
| `event_delete` | `[消したレコードの値]` |

```jsonc
"params": [{ "name": "keys", "source": "keys", "formula": "顧客コード" }]
```

```sql
DECLARE @keys = [];   -- 配列で宣言する（`pKeysNotArray`）
DECLARE @now = '';    -- 集計日時は計算式のパラメーターで渡す（DATE_FORMAT(NOW(), "YYYY-MM-DDTHH:mm:ssZ")）

-- 今の集計を「0 の行」として足してから集計する（消す文も 0 にする文も無いので、途中で失敗しても壊れない）
CREATE TEMP TABLE #t AS
SELECT 顧客コード, COUNT(*) AS 件数, SUM(金額) AS 売上
  FROM LAPP_受注 WHERE 顧客コード IN @keys GROUP BY 顧客コード
UNION ALL
SELECT 顧客コード, 0 AS 件数, 0 AS 売上
  FROM LAPP_集計 WHERE 顧客コード IN @keys;

UPSERT INTO LAPP_集計 (顧客コード, 件数, 売上, 集計日時)
SELECT 顧客コード, SUM(件数) AS 件数, SUM(売上) AS 売上, @now AS 集計日時
  FROM #t GROUP BY 顧客コード
ON DUPLICATE (顧客コード);

-- 行を残したくないときは、集計のあとで 0 の行だけ消す
DELETE FROM LAPP_集計 WHERE 顧客コード IN @keys AND 件数 = 0;
```

- **先に `UPDATE … SET 件数 = 0` で埋める形は勧めません**（書き込みが 2 倍、0 にしたあとで失敗すると 0 のまま残る）。
- **`@NOW()` は `SELECT` の列に書けません**。日時は `DATE_FORMAT(NOW(), …)` か `DATE_FORMAT("TODAY", …)` で渡します（計算式の `"TODAY"` は**現在日時**を返します）。`"NOW"` というトークンは無く、`DATE_FORMAT("NOW", …)` は `Invalid date` になります。

- **式が要ります**（空だと `pKeysFormula`）。対応する `DECLARE` は**配列**で書きます（`pKeysNotArray`）。
- 配列で宣言できるのは `_selected` とこの源泉だけです（ほかは `pArrayOnlySelected`）。
- 配列が**空**のときは実行しません。**空配列の `NOT IN` は全件**になるので、絞りは `IN @keys` 側に書いてください。
- `IN @keys` は読み取りにも書き込み（`UPDATE` / `DELETE` の `WHERE`）にも使えます。
- **数値で宣言した `DECLARE`**（`DECLARE @amount = 0;`）と対になる入力項目は **`type: "number"`**（または選択肢がすべて数で書かれた `"select"`）にします。
  `"text"` / `"date"` / `"datetime"` を当てると `pInputTypeMismatch` で**保存できません**。注入するのは文字列なので、
  文字を当てると**実行時には止まらず、そのまま条件に載る**（`金額 >= "abc"` が 0 件を返す）ためです。
  数値の条件に文字で絞らせたいときは、`DECLARE` を文字列（`= ''`）にして SQL の側で使い方を合わせます。

## 不備で大量に書き換えないための 4 段

**SQL やパラメーターの不備は、そのまま大量の書き換えになります。** `ASSERT` で守れるのは「書いた条件」だけで、
**打ち間違いや空は止まりません**。設定を作るときは、次の 4 段をそろえてください（既定のままでは ① と ③ が抜けます）。

| 段 | 何を防ぐか | 設定 |
|---|---|---|
| ① 入力の必須 | 空のまま実行して、**空の条件で広く当たる**こと | `inputs[].required: true`（**既定は `false`** なので明示する） |
| ② 実行条件 | レコードの項目が空のまま押すこと | `execCond` ＋ `execNgMessage`（押す前に止まり、理由が出る） |
| ③ 書き込み上限 | 桁違いに多いときに、**書く前に止める** | `writeLimit`（**既定は 0 = 無し**。件数の見当を聞いて必ず入れる） |
| ④ 書き込みの確認 | 件数を見てから決める | `confirm: true`（既定） |

- **いちばん効くのは ③ です。** 確認（④）は人が見落としますが、上限は機械が止めます（超える文は書かずに中止）。
  `confirm: false` にするなら `writeLimit` は**必須**です（検査が止めます）が、`confirm: true` でも入れてください。
- `WHERE 請求月 = @m` の `@m` が空なら、**請求月が空のレコードに当たります**。業務データは空の行がまとまりやすいので、
  空を通さない（① ②）のが先です。`ASSERT @m <> '', '…'` でも止められますが、**押す前に止まる ② のほうが親切**です。
- 一覧の一括と `source: "keys"` では、**空配列の `NOT IN` は全件**になります。絞りは `IN @_selected` / `IN @keys` 側に書きます。
- 作った SQL は **`kact_explain`** で見ます。パラメーターが条件に効いていなければ `kintone query: (全件取得)` と出ますし、
  `estimated API consumption` の `read` で読む量の見積もりも分かります。**書き込む文があるアクションは、必ず 1 本ずつ**見てください。
- 利用者に渡すときは、**上限の値とその根拠**（「1 か月の顧客は多くて 200 なので 300 にした」など）を一緒に伝えます。

## 容量

kintone のプラグイン設定の上限は**合計 256 KB**（圧縮して保存）。苦しくなったらアプリを分けて運用します。
