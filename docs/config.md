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

## アクション（`actions` の 1 要素）

```json
{
  "enabled": true,
  "code": "mark",
  "name": "印を付ける",
  "description": "",
  "type": "record",
  "placements": ["detail_menu"],
  "targetViews": [],
  "showCond": "",
  "execCond": "",
  "execNgMessage": "",
  "params": [{ "name": "cust", "source": "formula", "formula": "顧客コード" }],
  "inputs": [],
  "sql": "-- @ksql dialect: 1\nDECLARE @cust = '';\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 顧客コード = @cust;",
  "staticInsertRows": 0,
  "confirm": true,
  "writeLimit": 0,
  "allowed": [],
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
| `type` | `"record"` / `"list"` / `"app"` | レコード / 一覧の選択 / アプリ |
| `placements` | 下の表 | 複数可 |
| `targetViews` | 一覧 ID の配列 | 空 = すべての一覧。**一覧 ID は推測せず利用者に聞く** |
| `showCond` | 計算式 | 偽ならボタンを出さない（イベント起動には効かない） |
| `execCond` / `execNgMessage` | 計算式 | 偽なら実行せずメッセージ |
| `params` | `[{ name, source, formula }]` | `source` は `"formula"` か `"input"`。SQL の `DECLARE` と**過不足なく 1 対 1** |
| `inputs` | `[{ name, label, type, required, defaultFormula, options }]` | 実行時に聞く値。`type` は `text` / `number` / `date` / `datetime` / `select` / `relative_date`。**イベント起動には持てない** |
| `sql` | Flow dialect 1 | 1 本 20,000 字・20 文まで（`sql`） |
| `staticInsertRows` | 整数 | 素の `INSERT … VALUES` の行数（保存時にプラグインが数える。**AI は 0 のままでよい**） |
| `confirm` | 真偽 | 既定 `true`（件数の確認）。`false` にすると `writeLimit` が**必須** |
| `writeLimit` | 整数（0 = 無し） | 起動 1 回で書いてよい合計件数 |
| `allowed` | `[{ type, code, name? }]` | `type` は `USER` / `GROUP` / `ORGANIZATION`。空 = 全員。**誤操作防止**で、セキュリティ境界ではない |
| `resultMessage` | 計算式 | `_result_*` が使える（`formula`）。空 = 既定の文 |
| `listOnError` | `"continue"` / `"stop"` | 一覧の 1 件ずつのときだけ効く |
| `selectionMode` | `"loop"` / `"once"` / `"group"` | 一覧の選択の渡し方（`selection`） |
| `groupFormula` | 計算式 | `selectionMode: "group"` の**分ける式** |
| `perRecordLock` | 真偽 | ログアプリ指定時のみ。ロックキーにレコード ID を足す |
| `prevRecord` | 真偽 | 起動に `event_edit` があるときだけ。集計先が変わったときに**前の集計先も**直す |

### `placements`

| 値 | 場所 | 使える種類 |
|---|---|---|
| `detail_menu` | 詳細画面のヘッダー | record |
| `detail_space` | 詳細画面のスペース項目 | record |
| `index_menu` | 一覧のヘッダーメニュー | list / app |
| `index_panel` | 一覧のヘッダースペースのパネル | list / app |
| `event_create` | 保存後（追加） | record のみ |
| `event_edit` | 保存後（編集。一覧のインライン編集を含む） | record のみ |
| `event_status` | ステータス変更（遷移が確定した後の詳細画面で実行） | record のみ |

**イベント起動の決まり**: 確認なし（`confirm: false`）＋ `writeLimit` 必須 ＋ `inputs` なし ＋ `showCond` は効かない。
イベントは**ブラウザーの操作だけ**で動きます（REST API・CSV 読み込みでは動かない）。

## 容量

kintone のプラグイン設定の上限は**合計 256 KB**（圧縮して保存）。苦しくなったらアプリを分けて運用します。
