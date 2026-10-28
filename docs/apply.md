# テーブル（サブテーブル）への書き戻し

親レコードの**テーブル（サブテーブル）の行を全置換**できます。ただし**書ける形は 1 つだけ**です。

## 書ける形（これ以外は保存時に拒否）

```sql
-- @ksql dialect: 1
DECLARE @cust = '';

UPDATE LAPP_集計 SET 集計日時 = @NOW()
 WHERE 顧客コード = @cust
 APPLY 明細 (
   REMOVE ALL ROWS;
   APPEND (担当者, 件数, 金額)
   SELECT 担当者, COUNT(*) AS 件数, SUM(金額) AS 金額
     FROM LAPP_受注 WHERE 顧客コード = @cust
    GROUP BY 担当者
 );
```

| 決まり | 理由 |
|---|---|
| **`UPDATE … APPLY` だけ**（`INSERT` / `UPSERT` の `APPLY` は不可） | 書けるのはこの形だけ |
| **`REMOVE ALL ROWS` が必須**（`APPEND` と 2 つで 1 組） | 全置換だけを許す。これが無いと parse も検査も通って**実行時に失敗**するので、保存時に止める |
| **`APPEND (…) SELECT …`**（`VALUES` との同居・`PATCH` との同居・1 ブロックに 2 つは不可） | 同上 |
| **親が 1 件に決まる `WHERE`** | 1 文 = 1 つの親。2 件以上当たると**書く前に止まります**（専用のメッセージが出ます） |
| 多値の `APPLY`（複数テーブル）は不可 | |

- 親のキーは **「値の重複を禁止する」** にしてください。そうでないと検査に注意 `KSQL1307`
  （親の `WHERE` が 1 件に決まると読めない）が出ます。保存は止まりませんが、重複したときは実行時に止まります。
- **ソースの `SELECT` では as-of 関数が使えます**（`WHERE 受注日 >= @TODAY()`）。
- 並び順は `SUM(…) AS 別名` + `ORDER BY 別名`。テーブルの行はその順に入ります。
- **子行の上限**は共通設定の `applySubtableMax`（既定 500）。**`REMOVE ALL ROWS` で消える既存行も数えます**（1 文の合計）。
- 確認ダイアログには**子行の数**（足す行 / 消す行）と、戻せない操作である注意が出ます。
  書き込み上限（`writeLimit`）が数えるのは**親の件数**です（子行は数えません）。

## 複数の親に入れたいとき

`APPEND … SELECT` は **1 文 = 1 つの親**です。顧客ごと・部門ごとのように**複数の親**に入れるには、
一覧の選択の **「グループごと」**（`selectionMode: "group"`）で、分ける式の値ごとに実行を分けます（`selection`）。

## 一覧で選んだ複数レコードを 1 つのテーブルに入れる

**「1 件ずつ」では成立しません**（1 件ずつ回すと `REMOVE ALL ROWS` で前の行が消え、最後の 1 件しか残らない）。
**「まとめて 1 回」**（`selectionMode: "once"`）にして、ソースの `SELECT` を `WHERE $id IN @_selected` で絞ります。

```sql
-- @ksql dialect: 1
DECLARE @_selected = [];
DECLARE @cust = '';

UPDATE LAPP_顧客 SET 更新日時 = @NOW()
 WHERE 顧客コード = @cust
 APPLY 受注明細 (
   REMOVE ALL ROWS;
   APPEND (受注番号, 金額)
   SELECT 受注番号, 金額 FROM LAPP_受注 WHERE $id IN @_selected
 );
```
