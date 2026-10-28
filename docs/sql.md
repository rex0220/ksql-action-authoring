# SQL の規約（許す文・パラメーターの置ける場所）

エンジンは **kSQL（`@rex0220/kintone-sql-tools`）の Flow dialect 1**。SQL は**アクションごとに 1 本**。

- 1 行目に **`-- @ksql dialect: 1`**。
- **20 文まで**（`DECLARE` も 1 文と数える）、**1 本 20,000 字まで**。
- アプリは**論理アプリ名 `LAPP_<名前>`** で書く（共通設定の対応表。実アプリ ID を SQL に書かない）。
- 項目は**項目コード**（ラベルではない）。`$id` はレコード ID、`$revision` はリビジョン。

## 許す文 / 拒否する文

| 区分 | 文 |
|---|---|
| **許す** | `DECLARE`、`SET`、`CREATE TEMP TABLE`、`DROP TEMP TABLE`、`ASSERT`、`EXIT`、`INSERT … VALUES`、`INSERT … SELECT`、`UPDATE`、`DELETE`、`UPSERT` / `MERGE`、`REORDER`、および `apply` の形の `APPLY` |
| **拒否** | **トップレベルの `SELECT` / `WITH`**（結果の表示先がない）、`SHOW`、`DESCRIBE`、`EXPLAIN`、`VALIDATE ONLY`、`IMPORT`、CSV 系、**サブテーブルへの直接の DML**（`INSERT INTO アプリ$テーブル`）、`apply` の形以外の `APPLY` |

表に無い種類は**保存時に拒否**します（fail-closed）。`SELECT` は、許す文の中（`INSERT … SELECT`、`SET @x = (SELECT …)`、CTE、サブクエリ、一時テーブル）でだけ使えます。

## パラメーター（`DECLARE` の外部注入）

```sql
DECLARE @cust = '';          -- 既定値つきで宣言する
DECLARE @_selected = [];     -- 配列（「まとめて 1 回」「グループごと」の予約名）
```

- 注入するのは**その SQL が `DECLARE` している名前だけ**。設定の `params` / `inputs` と**過不足なく 1 対 1**（予約名は自動）。
  片方にしか無ければ**保存時エラー**です。
- 名前は `[A-Za-z_][A-Za-z0-9_]*`、64 字まで、**大文字小文字を無視して一意**。予約名（`_` 始まり）は設定に書けません。
- 値は**文字列として束縛**されます（文字列連結ではないので SQL インジェクションは起きない）。数値項目との比較は数値として効きます。
- **置ける場所**: `WHERE` / `HAVING` の比較右辺、`IN (@a, @b)`、`UPDATE` の `SET` 値、`ASSERT` のオペランド、`SELECT` の定数列、`KLIKE` の右辺。
  **`VALUES` の直接の要素には置けません** → `INSERT INTO … SELECT @x AS 列` の形で書く。
- 空の扱い: 必須の入力が空 = 実行前エラー。任意の入力が空 = **注入しない**（`DECLARE` の既定値が使われる）。計算式が空文字 = 空文字を注入。
- 型: 注入できるのは**文字列**（と予約名 `_selected` の**文字列の配列**）だけ。`null` / 真偽値 / `NaN` は実行前エラー。
  日付は `YYYY-MM-DD`、日時は ISO 8601（タイムゾーン付き）。

### 予約パラメーター

| 名前 | 値 | 使える種類 |
|---|---|---|
| `_app` | 自アプリ ID | すべて |
| `_user` | ログインユーザーのコード | すべて |
| `_record` | 処理対象のレコード ID | レコード / 一覧の「1 件ずつ」 |
| `_status` / `_prev_status` | 変更後 / 変更前のステータス | `event_status` のみ |
| `_selected` | 選んだレコードの `$id` の**配列** | 一覧の「まとめて 1 回」「グループごと」（`IN @_selected` でだけ使う） |
| `_group` | 分ける式の値 | 一覧の「グループごと」のみ |

## 相対日付

`RELATIVE_DATE` 注釈つきの `DECLARE` には、**許された日付関数のトークンだけ**を渡せます。
置ける場所は **`WHERE` の比較右辺と `BETWEEN` だけ**で、`SET` の値には使えません。
設定側は入力項目の `type: "relative_date"` と対にします。

## as-of 関数

`@NOW()` / `@TODAY()` は**起動 1 回につき 1 回だけ**決まり、一覧の全レコード・検証・実行で同じ値を使います。
基準のタイムゾーンは共通設定の `timezone`。`APPEND … SELECT` のソースでも使えます。

## ガードと冪等

```sql
ASSERT (SELECT COUNT(*) FROM LAPP_受注 WHERE 顧客コード = @cust) > 0
  MESSAGE '対象の受注がありません';
EXIT SUCCESS IF (SELECT COUNT(*) FROM LAPP_受注 WHERE 処理状況 <> '済') = 0;
```

- **`ASSERT` の `MESSAGE` は画面に出ます**（この製品で値を画面に出す唯一の例外）。
  だから**メッセージに業務データの値を書かない**（「対象がありません」のような固定の文にする）。
- 何度流しても同じ結果になる形（`UPSERT`、`DELETE` → `INSERT … SELECT`）で書く。`patterns` の 4 文がその形です。

## 注意（warning。保存は止まらない）

| コード | 意味 | どうするか |
|---|---|---|
| `KSQL1305` | 素の `INSERT` は再実行で重複し得る | 全置換（`DELETE` → `INSERT … SELECT`）では避けられない。利用者に伝えるだけ |
| `KSQL1307` | `APPLY` の親の `WHERE` が 1 件に決まると読めない | キーを「値の重複を禁止する」にする。できないなら、重複時は実行時に止まることを伝える |

知らないコードが来ても**エラー扱いにしない**（エンジンが診断を増やすため）。`kact_check` の `findings` の `level` に従います。

## 書くときに間違えやすいところ

- **`ORDER BY` に集計式そのものは書けません。** `SUM(金額) AS 売上` と別名を付けて `ORDER BY 売上` と書く
  （集計式を直接書くと parse エラー `KSQL1202`）。
- `GROUP BY` でキーをまとめると、**集計元が 0 件のときに 1 行も出ません**（集計先が古い値のまま残る）。`patterns` の形にする。
- 空配列の `NOT IN` は**全件**になります。「選択が空なら何もしない」は `IN @_selected` 側で書く。
- 別アプリは**自アプリと同じ領域**（通常領域どうし・同じゲストスペースどうし）だけ。
