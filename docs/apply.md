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
- **親の `SET` の右辺に、ほかのアプリを読むサブクエリは書けません。**
  `SET` の右辺の項目参照は、**サブクエリの中まで含めて「親アプリの項目」として**確かめられるので、
  `SET 件数 = (SELECT COUNT(*) FROM LAPP_受注 …)` は
  **`APPLY parent reference 金額 is not a top-level field.` で落ちます**
  （**保存は通ってしまいます**。`kact_explain` で先に見つかります）。
  合計を親にも入れるなら、**先に `SET` で変数に取ってから**渡します:

  ```sql
  SET @cnt = (SELECT COUNT(*) FROM LAPP_受注 WHERE $id IN @_selected);
  SET @amt = (SELECT SUM(金額) FROM LAPP_受注 WHERE $id IN @_selected);

  UPDATE LAPP_集計 SET 件数 = @cnt, 売上 = @amt, 集計日時 = @NOW()
   WHERE 顧客コード = @_group
   APPLY 明細 ( REMOVE ALL ROWS; APPEND (…) SELECT … );
  ```

  **`SET` は宣言を兼ねる**ので `DECLARE` は書きません（両方書くと「`SET` だけにしてください」で保存できません）。
  `SET` で作った変数は注入される値ではないので、**`params` の行も要りません**。
- **`APPLY` の対象のテーブルを、親の `SET` でも書くことはできません**
  （`APPLY target 明細 is also assigned by parent SET.`）。
- 並び順は `SUM(…) AS 別名` + `ORDER BY 別名`。テーブルの行はその順に入ります。
- **子行の上限**は共通設定の `applySubtableMax`（既定 500）。**`REMOVE ALL ROWS` で消える既存行も数えます**（1 文の合計）。
- 確認ダイアログには**子行の数**（足す行 / 消す行）と、戻せない操作である注意が出ます。
  書き込み上限（`writeLimit`）が数えるのは**親の件数**です（子行は数えません）。

## ループとは組み合わせない

**`APPLY … REMOVE ALL ROWS; APPEND … SELECT` は、回をまたいで同じ親を書くとループ（`loop`）では成立しません**（仕様 §5.7）。
全置換なので、回を重ねるたびに前の回の行が消え、**最後の 1 回ぶんしか残りません**。

**気づく手がかり**: この形になると、書き込みの文がループ値で絞られていないので
**注意 `wLoopWriteNoFilter` が出ます**（2026-11-06 に実地で確かめた）。
ループ値で絞った読み取りの結果を、`WHERE` が固定の親に `APPEND` している形がそれです。
ただし**注意は保存を止めません**し、検査が安全を証明できるわけでもないので、下の書き分けに寄せてください。

| 形 | 結果 | 検査 |
|---|---|---|
| 回ごとに**違う親**を書く（`WHERE … = @cust` でループ値が親を決める） | ○ 重ならないので残る | 注意なし |
| 回ごとに**同じ親**を書く（`WHERE` にループ値が無い） | **× 最後の 1 回ぶんだけ** | 注意 `wLoopWriteNoFilter` |

- 分けて流したいのに明細も要るなら、**明細を別アプリ**にして `UPSERT`（`patterns` の標準形）にします。
  連結キーを `CONCAT` で作れば、回をまたいでも行が残ります。
- テーブルのまま大量に扱いたいなら、ループではなく**親ごとに 1 回**実行する形
  （詳細画面のボタン、一覧の「1 件ずつ」「グループごと」）にします。

## 複数の親に入れたいとき

`APPEND … SELECT` は **1 文 = 1 つの親**です。顧客ごと・部門ごとのように**複数の親**に入れるには、
一覧で選んだレコードの **「グループごと」**（`selectionMode: "group"`）で、分ける式の値ごとに実行を分けます（`selection`）。

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
