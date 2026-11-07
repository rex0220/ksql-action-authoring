// kact_try（式の試し計算）の試験。kintone には通信しない（項目定義は控えのファイル）。
// 評価は利用者の zip の authoring API（版 4 以降）に任せるので、zip が無ければ skip。使い方: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ZIP = process.env.KACT_PLUGIN_ZIP?.trim() || fileURLToPath(new URL("../../ksql-action/dist/ksql-action-plugin1.zip", import.meta.url));
const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
mkdirSync("dist", { recursive: true });
await esbuild.build({ entryPoints: ["src/try.ts"], bundle: true, format: "esm", platform: "node", outfile: "dist/try.test-bundle.mjs", external: ["happy-dom"], logLevel: "warning" });
const { tryFormulas } = await import(pathToFileURL("dist/try.test-bundle.mjs").href);

const skip = !existsSync(ZIP);

// 控えの項目定義（kact_fields が置く形）。実アプリの値は使わない
const ws = mkdtempSync(join(tmpdir(), "kact-try-"));
mkdirSync(join(ws, "fields/dev"), { recursive: true });
writeFileSync(
  join(ws, "fields/dev/APP1001.json"),
  JSON.stringify({
    tool: "kact fields",
    fetchedAt: new Date().toISOString(),
    profile: "dev",
    host: "example.cybozu.com",
    appId: 1001,
    appName: "受注",
    revision: "1",
    preview: false,
    properties: {
      // 複数選択のときの動きも見るので、選択肢は 2 つにしてある（実機の 4399 は "Y" だけ）
      確認済: { type: "CHECK_BOX", code: "確認済", label: "確認済", options: { A: { label: "A", index: "0" }, Y: { label: "Y", index: "1" } } },
      担当: { type: "SINGLE_LINE_TEXT", code: "担当", label: "担当" },
      金額: { type: "NUMBER", code: "金額", label: "金額" },
      点検日: { type: "DATE", code: "点検日", label: "点検日" },
      明細: { type: "SUBTABLE", code: "明細", label: "明細", fields: { 単価: { type: "NUMBER", code: "単価", label: "単価" } } },
    },
  }),
);
const opt = { pluginZip: ZIP, workspaceDir: ws };
const one = (r) => {
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  return r.results[0];
};

test("kact_try: 値・条件の真偽・注入される文字列を返す", { skip }, async () => {
  const r = await tryFormulas(
    {
      app: 1001,
      data: { 確認済: [], 担当: "佐藤", 点検日: "2026-11-04" },
      formulas: [
        { formula: 'NOT(IN(確認済, "Y"))', as: "condition" },
        { formula: "担当", as: "param" },
        { formula: 'DATE_FORMAT(点検日, "YYYY/MM/DD")' },
      ],
    },
    opt,
  );
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.equal(r.context, "record");
  assert.equal(r.fieldsFrom, "fields/dev/APP1001.json");
  // 表示条件: 確認済 が空なら真（ボタンを出す）
  assert.equal(r.results[0].value, true);
  assert.equal(r.results[0].condition, true);
  // 真偽はパラメーターにできない（toParamValue は文字列・数値だけ）
  assert.equal(r.results[0].param, undefined);
  assert.ok(r.results[0].paramNg, JSON.stringify(r.results[0]));
  assert.equal(r.results[1].value, "佐藤");
  assert.equal(r.results[1].param, "佐藤");
  assert.equal(r.results[2].value, "2026/11/04");
});

test("kact_try: 値を変えると条件の真偽が変わる", { skip }, async () => {
  const r = await tryFormulas({ app: 1001, data: { 確認済: ["Y"] }, formulas: [{ formula: 'NOT(IN(確認済, "Y"))', as: "condition" }] }, opt);
  const v = one(r);
  assert.equal(v.value, false);
  assert.equal(v.condition, false);
});

test("kact_try: 数値は指数表記にせず文字列化する（実行時と同じ）", { skip }, async () => {
  const r = await tryFormulas({ app: 1001, data: { 金額: 1234.5 }, formulas: [{ formula: "金額 * 2", as: "param" }] }, opt);
  const v = one(r);
  assert.equal(v.value, 2469);
  assert.equal(v.param, "2469");
});

// テーブルの子は kintone のレコードと同じく文字列で入るので、SUM は**文字列**を返す（実機と同じ。
// 項目の値を素で掛ける 金額 * 2 は数値になる）。kact_try はエンジンが返したものをそのまま見せる
test("kact_try: テーブルの行を渡せる（SUM は文字列で返る）", { skip }, async () => {
  const r = await tryFormulas({ app: 1001, data: { 明細: [{ 単価: 100 }, { 単価: 250 }] }, formulas: [{ formula: "SUM(単価)", as: "param" }] }, opt);
  const v = one(r);
  assert.equal(v.value, "350");
  assert.equal(v.valueType, "string");
  assert.equal(v.param, "350");
});

test("kact_try: result を渡すと $result_* が使える", { skip }, async () => {
  const r = await tryFormulas({ app: 1001, result: { $result_updated: 4, $result_status: "success" }, formulas: [{ formula: '"updated=" & $result_updated' }] }, opt);
  assert.equal(r.withResult, true);
  assert.equal(one(r).value, "updated=4");
});

test("kact_try: loop を渡すと $val / $lno が使える（型はそのまま）", { skip }, async () => {
  const r = await tryFormulas({ loop: { val: 2017, lno: 0 }, formulas: [{ formula: "2017 + $val", as: "param" }, { formula: "$lno" }] }, opt);
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.deepEqual(r.loop, { val: 2017, lno: 0 });
  // 数で渡したので足し算になる（文字列で渡すと連結。実行時の withLoopRecord と同じ）
  assert.equal(r.results[0].param, "4034");
  // $lno は数のまま返る（型が分かるように valueType も見る）
  assert.equal(r.results[1].value, 0);
  assert.equal(r.results[1].valueType, "number");
});

test("kact_try: loop の値は文字列でもよい（連結になる）", { skip }, async () => {
  const r = await tryFormulas({ loop: { val: "2026-09", lno: 2 }, formulas: [{ formula: '"月=" & $val & "/" & $lno', as: "param" }] }, opt);
  assert.equal(r.results[0].param, "月=2026-09/2");
});

test("kact_try: loop を渡さなければ $val は無い項目", { skip }, async () => {
  const r = await tryFormulas({ formulas: [{ formula: "$val" }] }, opt);
  assert.equal(r.loop, undefined);
  assert.equal(r.results[0].ok, false);
});

test("kact_try: loop.val に配列や真偽値は渡せない", { skip }, async () => {
  const r = await tryFormulas({ loop: { val: [1, 2] }, formulas: [{ formula: "$val" }] }, opt);
  assert.equal(r.status, "invalid");
  assert.ok(r.findings.some((f) => /loop\.val/.test(f.message)), JSON.stringify(r.findings));
});

test("kact_try: 項目の無い文脈では項目参照が誤りになる（種類 app と同じ）", { skip }, async () => {
  const r = await tryFormulas({ formulas: [{ formula: 'LOGIN_INFO("code")' }, { formula: "担当" }], user: { code: "demo_user01" } }, opt);
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.equal(r.context, "none");
  assert.equal(r.results[0].value, "demo_user01");
  assert.equal(r.results[1].ok, false);
  assert.ok(/担当/.test(r.results[1].error ?? ""), r.results[1].error);
});

test("kact_try: 評価に失敗した式だけが ok: false（ほかは止めない）", { skip }, async () => {
  const r = await tryFormulas({ app: 1001, formulas: [{ formula: "無い項目 + 1" }, { formula: '"ok"' }] }, opt);
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.equal(r.results[0].ok, false);
  assert.equal(r.results[1].value, "ok");
});

// チェックボックスは = で比べると単一選択のときしか合わない（複数だと "A,Y" との比較になる）。
// 2026-11-03 に実機の控えで測った値を固定する（資料 docs/formula.md の表の根拠）
test("kact_try: チェックボックスは IN で判定する（= は複数選択で外れる）", { skip }, async () => {
  const formulas = [
    { formula: 'IN(確認済, "Y")', as: "condition" },
    { formula: '確認済 = "Y"', as: "condition" },
    { formula: "確認済" },
    { formula: "ARRAY_COUNT(確認済)" },
    { formula: "LENGTH(確認済)" },
  ];
  const empty = await tryFormulas({ app: 1001, data: { 確認済: [] }, formulas }, opt);
  assert.equal(empty.status, "ok", JSON.stringify(empty.findings));
  assert.deepEqual(empty.results.map((r) => r.value), [false, false, "", 0, 0]);

  const single = await tryFormulas({ app: 1001, data: { 確認済: ["Y"] }, formulas }, opt);
  assert.deepEqual(single.results.map((r) => r.value), [true, true, "Y", 1, 1]);

  // 複数選択: IN は真のまま、= は偽になる。素で読むとカンマ連結、LENGTH は文字数
  const multi = await tryFormulas({ app: 1001, data: { 確認済: ["A", "Y"] }, formulas }, opt);
  assert.deepEqual(multi.results.map((r) => r.value), [true, false, "A,Y", 2, 3]);
  // カンマ連結の文字列はパラメーターに渡せる（SQL 側で SET すると配列に戻る）
  assert.equal(multi.results[2].param, "A,Y");
});

test("kact_try: 選択肢に無い値は invalid（名指し。打ち間違いを拾う）", { skip }, async () => {
  const r = await tryFormulas({ app: 1001, data: { 確認済: ["Y", "Z"] }, formulas: [{ formula: '"a"' }] }, opt);
  assert.equal(r.status, "invalid");
  assert.ok(r.findings.some((f) => /選択肢に無い値 "Z"/.test(f.message)), JSON.stringify(r.findings));
  // 選択肢にある値だけなら通る。空（未選択）も通る
  assert.equal((await tryFormulas({ app: 1001, data: { 確認済: ["Y"] }, formulas: [{ formula: '"a"' }] }, opt)).status, "ok");
  assert.equal((await tryFormulas({ app: 1001, data: { 確認済: [] }, formulas: [{ formula: '"a"' }] }, opt)).status, "ok");
});

test("kact_try: 選択肢の無い型（文字列・数値）は値を見ない", { skip }, async () => {
  const r = await tryFormulas({ app: 1001, data: { 担当: "だれでもよい", 金額: 123 }, formulas: [{ formula: "担当" }] }, opt);
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
});

test("kact_try: 項目定義に無い項目を data に書いたら invalid（名指し）", { skip }, async () => {
  const r = await tryFormulas({ app: 1001, data: { 無い項目: "x" }, formulas: [{ formula: '"a"' }] }, opt);
  assert.equal(r.status, "invalid");
  assert.ok(r.findings.some((f) => /無い項目/.test(f.message)), JSON.stringify(r.findings));
});

test("kact_try: テーブルを配列でなく渡したら invalid", { skip }, async () => {
  const r = await tryFormulas({ app: 1001, data: { 明細: { 単価: 100 } }, formulas: [{ formula: '"a"' }] }, opt);
  assert.equal(r.status, "invalid");
  assert.ok(r.findings.some((f) => /行の配列/.test(f.message)), JSON.stringify(r.findings));
});

test("kact_try: 控えが無いアプリは invalid（先に kact_fields）", { skip }, async () => {
  const r = await tryFormulas({ app: 9999, formulas: [{ formula: '"a"' }] }, opt);
  assert.equal(r.status, "invalid");
  assert.ok(r.findings.some((f) => f.code === "fields-missing"), JSON.stringify(r.findings));
});

test("kact_try: 11 本以上と 0 本は invalid（探索を続けない）", { skip }, async () => {
  const many = Array.from({ length: 11 }, () => ({ formula: '"a"' }));
  assert.equal((await tryFormulas({ formulas: many }, opt)).status, "invalid");
  assert.equal((await tryFormulas({ formulas: [] }, opt)).status, "invalid");
});

test("kact_try: data は項目の無い文脈では使えない", { skip }, async () => {
  const r = await tryFormulas({ context: "none", data: { 担当: "佐藤" }, formulas: [{ formula: '"a"' }] }, opt);
  assert.equal(r.status, "invalid");
});

/**
 * 共通の文（`$m_…`）の試し計算（2026-11-07 の Codex レビュー #4）。
 *
 * それまでは `contextsFrom` に `messages` を渡しておらず、**`messages` に正しく定義した文まで
 * 「無い項目」**になっていた（`kact_check` 側は 0.11.1 で直したが、`kact_try` に残っていた）。
 *
 * 値の作り方は実行時と同じ（本体の `messageValues`〈版 7〉＋ `withResultRecord`〈版 4〉。
 * 実行時の `withMessageRecord` の中身がこの 2 つ）。**判定も文も tools に写さない**。
 *
 * **口（`slot`）を見る**のが肝: `$m_…` を書けるのは 3 つの口だけなので、無条件に入れると
 * 「`kact_try` では通るのに `kact_check` が拒む」式を作れてしまう（今の不具合の裏返し）。
 */
const CONFIG_WITH_MESSAGES = JSON.stringify({
  date: "2026-11-07 00:00",
  pluginName: "kSQL アクション",
  pluginID: "rex0220 ksql action",
  PluginVersion: "1",
  appId: 1001,
  appName: "受注",
  configVersion: 1,
  bindings: [{ name: "受注", appId: 1001 }],
  messages: [
    { code: "m_done", text: "{n} 件を書き込みました", text_en: "Wrote {n} records" },
    { code: "m_no_amount", text: "金額が空です" },
  ],
  limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
  timezone: "",
  actions: [],
});
writeFileSync(join(ws, "with-messages.json"), CONFIG_WITH_MESSAGES);

test("kact_try: file を渡すと共通の文（$m_…）を試せる", { skip }, async () => {
  const r = await tryFormulas(
    { app: 1001, file: "with-messages.json", formulas: [{ formula: "$m_done", slot: "resultMessage" }] },
    opt,
  );
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.equal(r.messages, 2);
  assert.equal(r.results[0].ok, true, JSON.stringify(r.results[0]));
  assert.equal(r.results[0].value, "{n} 件を書き込みました");
});

test("kact_try: 共通の文は lang で切り替わる", { skip }, async () => {
  const r = await tryFormulas(
    { app: 1001, file: "with-messages.json", lang: "en", formulas: [{ formula: "$m_done", slot: "resultMessage" }] },
    opt,
  );
  assert.equal(r.results[0].value, "Wrote {n} records");
  // 英語の文が無い文は既定の文に落ちる（本体の messageTexts と同じ）
  const fallback = await tryFormulas(
    { app: 1001, file: "with-messages.json", lang: "en", formulas: [{ formula: "$m_no_amount", slot: "execNgMessage" }] },
    opt,
  );
  assert.equal(fallback.results[0].value, "金額が空です");
});

test("kact_try: $m_… を書けない口では「無い項目」になる（kact_check と同じ）", { skip }, async () => {
  const r = await tryFormulas(
    { app: 1001, file: "with-messages.json", formulas: [{ formula: "$m_done", slot: "showCond" }] },
    opt,
  );
  assert.equal(r.results[0].ok, false, "表示条件に共通の文は書けない");
  // 黙って落とさず、どこなら書けるかを言う
  const w = r.findings.find((f) => f.code === "slot-not-allowed");
  assert.ok(w, JSON.stringify(r.findings));
  assert.match(w.message, /execNgMessage/);
});

test("kact_try: slot を書かない式には共通の文を入れない（知らせる）", { skip }, async () => {
  const r = await tryFormulas(
    { app: 1001, file: "with-messages.json", formulas: [{ formula: "$m_done" }] },
    opt,
  );
  assert.equal(r.results[0].ok, false);
  assert.ok(r.findings.some((f) => f.code === "slot-missing"), JSON.stringify(r.findings));
});

test("kact_try: slot は $result_* と $val の口も分ける", { skip }, async () => {
  // $result_* は結果メッセージだけ
  const okResult = await tryFormulas(
    { app: 1001, result: { $result_updated: 4 }, formulas: [{ formula: '"更新 " & $result_updated', slot: "resultMessage" }] },
    opt,
  );
  assert.equal(okResult.results[0].value, "更新 4", JSON.stringify(okResult.findings));
  const ngResult = await tryFormulas(
    { app: 1001, result: { $result_updated: 4 }, formulas: [{ formula: "$result_updated", slot: "execCond" }] },
    opt,
  );
  assert.equal(ngResult.results[0].ok, false, "実行条件に $result_* は書けない");
  assert.ok(ngResult.findings.some((f) => f.code === "slot-not-allowed"), JSON.stringify(ngResult.findings));

  // $val / $lno はパラメーターの式だけ
  const okLoop = await tryFormulas(
    { app: 1001, loop: { val: 2017, lno: 0 }, formulas: [{ formula: "2017 + $val", as: "param", slot: "param" }] },
    opt,
  );
  assert.equal(okLoop.results[0].param, "4034", JSON.stringify(okLoop.findings));
  const ngLoop = await tryFormulas(
    { app: 1001, loop: { val: 2017, lno: 0 }, formulas: [{ formula: "$val", slot: "showCond" }] },
    opt,
  );
  assert.equal(ngLoop.results[0].ok, false, "表示条件に $val は書けない");
});

test("kact_try: slot には app（控え）が要る／作業フォルダーの外は読まない", { skip }, async () => {
  const noApp = await tryFormulas({ formulas: [{ formula: '"x"', slot: "resultMessage" }] }, opt);
  assert.equal(noApp.status, "invalid");
  // 作業フォルダーの外に本当にファイルを置いてから（無いだけの not-found と区別する）
  writeFileSync(join(ws, "..", "kact-try-outside.json"), CONFIG_WITH_MESSAGES);
  const outside = await tryFormulas({ app: 1001, file: "../kact-try-outside.json", formulas: [{ formula: '"x"' }] }, opt);
  assert.equal(outside.status, "denied", JSON.stringify(outside.findings));
});

