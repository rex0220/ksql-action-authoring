// 中核（status / check / actions）の試験。実際の zip（開発中の ksql-action の dist）を読む。
// 使い方: npm test（zip が無ければ skip）
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// zip の場所は KACT_PLUGIN_ZIP か、隣に置いた本体のリポジトリ（無ければ skip）
const ZIP = process.env.KACT_PLUGIN_ZIP?.trim() || fileURLToPath(new URL("../../ksql-action/dist/ksql-action-plugin1.zip", import.meta.url));
const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
mkdirSync("dist", { recursive: true });

// TS の中核を束ねて読み込む（ビルドの口ができるまでの暫定）。
// **束ねた先はリポジトリの中**（dist/）にする。paths.ts が package.json をファイルの位置から探すため
const out = "dist/core.test-bundle.mjs";
await esbuild.build({
  entryPoints: ["src/core.ts"], bundle: true, format: "esm", platform: "node", outfile: out,
  external: ["happy-dom"], logLevel: "warning",
});
const core = await import(pathToFileURL(out).href);

const skip = !existsSync(ZIP);

test("statusOf: zip から版と API の版を読む", { skip }, async () => {
  const r = await core.statusOf({ pluginZip: ZIP });
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.ok(r.tools.supportedApiVersions.includes(r.plugin.apiVersion), `API の版: ${r.plugin.apiVersion} / tools: ${r.tools.supportedApiVersions.join(",")}`);
  assert.equal(r.plugin.formulaEngine, true);
  assert.match(r.plugin.pluginId ?? "", /^[a-z]{32}$/);
  assert.ok(r.plugin.sha256.engine.length === 64);
});

test("statusOf: zip が無いときは failed（例外にしない）", async () => {
  const r = await core.statusOf({ pluginZip: "/no/such/plugin.zip" });
  assert.equal(r.status, "failed");
  assert.ok(r.findings.length > 0);
});

const envelope = (config) => JSON.stringify({
  date: "2026-10-28 00:00", pluginName: "kSQL アクション", pluginID: "rex0220 ksql action",
  PluginVersion: "1", appId: 4377, appName: "受注", ...config,
});

test("checkConfig: 正しい設定は ok", { skip }, async () => {
  const config = {
    configVersion: 1,
    bindings: [{ name: "受注", appId: 4377 }, { name: "取込", appId: 4379 }],
    limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
    timezone: "",
    actions: [{
      enabled: true, code: "fetch", name: "取り込む", description: "", type: "list", placements: ["index_panel"],
      targetViews: [], showCond: "", execCond: "", execNgMessage: "", params: [], inputs: [],
      sql: "-- @ksql dialect: 1\nDECLARE @_group = '';\nDECLARE @_selected = [];\nUPDATE LAPP_取込 SET 件数 = 0 WHERE 顧客コード = @_group\n APPLY 明細 (REMOVE ALL ROWS; APPEND (受注番号, 金額) SELECT $id, 金額 FROM LAPP_受注 WHERE $id IN @_selected ORDER BY $id);",
      staticInsertRows: 0, confirm: true, writeLimit: 0, allowed: [], resultMessage: "",
      listOnError: "continue", selectionMode: "group", groupFormula: "顧客コード", perRecordLock: false, prevRecord: false,
    }],
  };
  const r = await core.checkConfig(envelope(config), { pluginZip: ZIP });
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.equal(r.summary.actions, 1);
  assert.deepEqual(r.summary.bindings, ["受注=4377", "取込=4379"]);
});

test("checkConfig: 今の形（種類 record ＋ 一覧でも使う ＋ 一覧パネル）も ok。古い形は migrate して通る", { skip }, async () => {
  // 2026-10-31 の形: 種類は record / app の 2 つ、一覧画面は onList ＋ panel（区分と一覧の表）で決める
  const now = {
    configVersion: 1,
    bindings: [{ name: "受注", appId: 4377 }],
    limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
    timezone: "",
    progressStyle: "dialog",
    panel: {
      title: "",
      sections: [{ enabled: true, name: "受注", color: "blue", tone: "soft", collapsed: false }],
      views: [{ viewId: "*", sections: ["受注"], menus: [], open: false }],
    },
    actions: [{
      enabled: true, code: "close", name: "締める", description: "", type: "record", onList: true,
      placements: ["detail_menu"], panelSection: "受注",
      showCond: "", execCond: "", execNgMessage: "", params: [], inputs: [],
      sql: "-- @ksql dialect: 1\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE $id = @_record;",
      staticInsertRows: 0, confirm: true, writeLimit: 0, refreshPrompt: "auto",
      allowed: [], allowAll: true, resultMessage: "",
      listOnError: "continue", selectionMode: "loop", groupFormula: "", perRecordLock: false, prevRecord: false,
    }],
  };
  const r = await core.checkConfig(envelope(now), { pluginZip: ZIP });
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  const listed = await core.listActions(envelope(now), { pluginZip: ZIP });
  assert.equal(listed.actions[0].type, "record");
  assert.equal(listed.actions[0].onList, true);
  assert.equal(listed.actions[0].panelSection, "受注");
  assert.equal(listed.actions[0].selectionMode, "loop");

  // 古い形（種類 list・targetViews・index_panel・panel 無し）も、取り込みと同じ順で直してから検査するので通る
  const old = JSON.parse(JSON.stringify(now));
  delete old.panel;
  delete old.progressStyle;
  old.actions = [{ ...now.actions[0], type: "list", onList: undefined, placements: ["index_panel"], targetViews: [], panelSection: "受注" }];
  delete old.actions[0].onList;
  delete old.actions[0].refreshPrompt;
  delete old.actions[0].allowAll;
  const r2 = await core.checkConfig(envelope(old), { pluginZip: ZIP });
  assert.equal(r2.status, "ok", JSON.stringify(r2.findings));
  const listed2 = await core.listActions(envelope(old), { pluginZip: ZIP });
  assert.equal(listed2.actions[0].type, "record", "種類 list は record ＋ 一覧でも使う に直る");
  assert.equal(listed2.actions[0].onList, true);
});

test("explainAction: 控えの項目定義だけで実行計画を出す（kintone には行かない）", { skip }, async () => {
  const props = (names) =>
    Object.fromEntries(names.map((n) => [n, { type: n === "金額" || n === "件数" ? "NUMBER" : "SINGLE_LINE_TEXT", code: n, label: n }]));
  const config = {
    configVersion: 1,
    bindings: [{ name: "受注", appId: 4377 }, { name: "集計", appId: 4378 }],
    limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
    timezone: "",
    actions: [{
      enabled: true, code: "agg", name: "集計", description: "", type: "app", onList: false,
      placements: [], panelSection: "", showCond: "", execCond: "", execNgMessage: "", params: [], inputs: [],
      sql: "-- @ksql dialect: 1\nINSERT INTO LAPP_集計 (顧客コード, 件数) SELECT 顧客コード, COUNT(*) FROM LAPP_受注 GROUP BY 顧客コード;",
      staticInsertRows: 0, confirm: true, writeLimit: 0, refreshPrompt: "auto", allowed: [], allowAll: true,
      resultMessage: "", listOnError: "continue", selectionMode: "loop", groupFormula: "", perRecordLock: false, prevRecord: false,
    }],
  };
  const fields = { "4377": props(["顧客コード", "金額"]), "4378": props(["顧客コード", "件数"]) };
  const r = await core.explainAction(envelope(config), { action: "agg" }, { pluginZip: ZIP, fields });
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.equal(r.action.code, "agg");
  assert.equal(r.statements.length, 1);
  assert.match(r.statements[0].type, /INSERT/i);
  assert.ok(r.statements[0].plan.join("\n").length > 0, "計画の行がある");
  assert.deepEqual(r.findings, [], "控えがそろっていれば注意は出ない");

  // 番号でも引ける。知らないコードは invalid
  const byIndex = await core.explainAction(envelope(config), { action: 1 }, { pluginZip: ZIP, fields });
  assert.equal(byIndex.status, "ok");
  const missing = await core.explainAction(envelope(config), { action: "no-such" }, { pluginZip: ZIP, fields });
  assert.equal(missing.status, "invalid");
  assert.equal(missing.findings[0].code, "action-not-found");

  // 控えが無ければ、その番号を知らせる（通信はしない）
  const noFields = await core.explainAction(envelope(config), { action: "agg" }, { pluginZip: ZIP });
  assert.ok(noFields.findings.some((f) => f.code === "fields-missing"), JSON.stringify(noFields.findings));
});

test("checkConfig: 許されない SQL は invalid（プラグイン本体と同じ規則）", { skip }, async () => {
  const config = {
    configVersion: 1, bindings: [{ name: "受注", appId: 4377 }],
    limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
    timezone: "",
    actions: [{
      enabled: true, code: "bad", name: "だめな SQL", description: "", type: "record", placements: ["detail_menu"],
      targetViews: [], showCond: "", execCond: "", execNgMessage: "", params: [], inputs: [],
      // トップレベルの SELECT は許可文の表に無い
      sql: "-- @ksql dialect: 1\nSELECT 顧客コード FROM LAPP_受注;\nUPDATE LAPP_受注 SET 金額 = 1 WHERE 顧客コード = 'C001';",
      staticInsertRows: 0, confirm: true, writeLimit: 0, allowed: [], resultMessage: "",
      listOnError: "continue", selectionMode: "loop", groupFormula: "", perRecordLock: false, prevRecord: false,
    }],
  };
  const r = await core.checkConfig(envelope(config), { pluginZip: ZIP });
  assert.equal(r.status, "invalid");
  assert.ok(r.findings.some((f) => f.code === "pStatement"), JSON.stringify(r.findings));
});

test("checkConfig: 封筒の pluginID が違えば invalid", { skip }, async () => {
  const r = await core.checkConfig(JSON.stringify({ pluginID: "other", configVersion: 1 }), { pluginZip: ZIP });
  assert.equal(r.status, "invalid");
  assert.equal(r.findings[0].code, "parse-failed");
});

test("listActions: 一覧に SQL 本文を含めない", { skip }, async () => {
  const config = {
    configVersion: 1, bindings: [{ name: "受注", appId: 4377 }],
    limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
    timezone: "",
    actions: [{
      enabled: true, code: "a1", name: "試験", description: "", type: "list", placements: ["index_panel"],
      targetViews: [], showCond: "", execCond: "", execNgMessage: "", params: [{ name: "cust", source: "input", formula: "" }],
      inputs: [{ name: "cust", label: "顧客", type: "text", required: false, defaultFormula: "", options: [] }],
      sql: "-- @ksql dialect: 1\nDECLARE @cust = '';\nUPDATE LAPP_受注 SET 金額 = 1 WHERE 顧客コード = @cust APPLY 明細 (REMOVE ALL ROWS);",
      staticInsertRows: 0, confirm: true, writeLimit: 10, allowed: [], resultMessage: "",
      listOnError: "continue", selectionMode: "once", groupFormula: "", perRecordLock: false, prevRecord: false,
    }],
  };
  const r = await core.listActions(envelope(config), { pluginZip: ZIP });
  assert.equal(r.status, "ok");
  assert.equal(r.actions.length, 1);
  const a = r.actions[0];
  assert.equal(a.selectionMode, "once");
  assert.equal(a.apply, true);
  assert.deepEqual(a.params, ["cust"]);
  assert.equal(JSON.stringify(r).includes("LAPP_受注"), false, "SQL 本文が混ざっている");
});

// 保存時の structuralProblems と同じ規則が validateConfig 経由で通ること（2026-10-28 に本体へ足した抜け）
test("checkConfig: 「グループごと」で分ける式が空なら invalid", { skip }, async () => {
  const config = {
    configVersion: 1, bindings: [{ name: "受注", appId: 4377 }],
    limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
    timezone: "",
    actions: [{
      enabled: true, code: "g1", name: "グループごと", description: "", type: "list", placements: ["index_panel"],
      targetViews: [], showCond: "", execCond: "", execNgMessage: "", params: [], inputs: [],
      sql: "-- @ksql dialect: 1\nDECLARE @_group = '';\nDECLARE @_selected = [];\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 顧客コード = @_group AND $id IN @_selected;",
      staticInsertRows: 0, confirm: true, writeLimit: 0, allowed: [], resultMessage: "",
      listOnError: "continue", selectionMode: "group", groupFormula: "", perRecordLock: false, prevRecord: false,
    }],
  };
  const r = await core.checkConfig(envelope(config), { pluginZip: ZIP });
  assert.equal(r.status, "invalid", JSON.stringify(r.findings));
  assert.ok(r.findings.some((f) => f.code === "config" && f.message.includes("group:formula")), JSON.stringify(r.findings));
});

// ガード文の形（docs/sql.md の「ガードと冪等」）。資料の例が実物のエンジンで通ることを固定する。
// 2026-10-28 の試用で、資料が `MESSAGE '…'` と書いていてパースできなかった（正しくは `, '…'`）
const guard = (sql) => ({
  configVersion: 1, bindings: [{ name: "受注", appId: 1001 }],
  limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
  timezone: "",
  actions: [{
    enabled: true, code: "guard", name: "ガード", description: "", type: "record", placements: ["detail_menu"],
    targetViews: [], showCond: "", execCond: "", execNgMessage: "",
    params: [{ name: "cust", source: "formula", formula: "顧客コード" }], inputs: [],
    sql,
    staticInsertRows: 0, confirm: true, writeLimit: 0, allowed: [], resultMessage: "",
    listOnError: "continue", selectionMode: "loop", groupFormula: "", perRecordLock: false, prevRecord: false,
  }],
});
const HEAD = "-- @ksql dialect: 1\nDECLARE @cust = '';\n";
const WRITE = "\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 顧客コード = @cust;";

test("checkConfig: ガードは コンマ + メッセージ の形なら ok（文字列リテラルも置ける）", { skip }, async () => {
  for (const g of [
    "ASSERT @cust <> '', '顧客コードがありません';",
    "ASSERT @cust <> '';",
    "ASSERT WARN @cust <> '', '注意だけ';",
    "ASSERT (SELECT COUNT(*) FROM LAPP_受注 WHERE 顧客コード = @cust) > 0, '対象がありません';",
    "EXIT SUCCESS IF (SELECT COUNT(*) FROM LAPP_受注 WHERE 顧客コード = @cust) = 0, '対象がありません';",
  ]) {
    const r = await core.checkConfig(envelope(guard(HEAD + g + WRITE)), { pluginZip: ZIP });
    assert.equal(r.status, "ok", `${g} / ${JSON.stringify(r.findings)}`);
  }
});

test("checkConfig: 構文が通らないガードは pParse だけ（行番号つき。派生のエラーを出さない）", { skip }, async () => {
  for (const g of [
    "ASSERT @cust <> '' MESSAGE 'だめ';",                    // MESSAGE という語は無い
    "ASSERT (@cust <> '') MESSAGE 'だめ';",                   // 条件全体を括弧で包めない
    "ASSERT @cust <> '' AND @cust <> 'X', 'だめ';",           // AND / OR の複合条件は不可
    "EXIT SUCCESS IF @cust <> '';",                          // EXIT はメッセージ必須
  ]) {
    const r = await core.checkConfig(envelope(guard(HEAD + g + WRITE)), { pluginZip: ZIP });
    assert.equal(r.status, "invalid", g);
    const errors = r.findings.filter((f) => f.level === "error");
    assert.deepEqual(errors.map((f) => f.code), ["pParse"], `${g} / ${JSON.stringify(errors)}`);
    assert.match(errors[0].message, /^\d+ 行目: /, errors[0].message);
  }
});

// 計算式の構文（2026-10-28 の試用 S3 で、引用符が落ちた resultMessage を ok で通した）
const formulaAction = (over) => ({
  configVersion: 1, bindings: [{ name: "受注", appId: 1001 }],
  limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
  timezone: "",
  actions: [{
    enabled: true, code: "f1", name: "式の試験", description: "", type: "record", placements: ["detail_menu"],
    targetViews: [], showCond: "", execCond: "", execNgMessage: "",
    params: [{ name: "cust", source: "formula", formula: "顧客コード" }], inputs: [],
    sql: HEAD + WRITE,
    staticInsertRows: 0, confirm: true, writeLimit: 0, allowed: [], resultMessage: "",
    listOnError: "continue", selectionMode: "loop", groupFormula: "", perRecordLock: false, prevRecord: false,
    ...over,
  }],
});

test("checkConfig: 式の構文が通らなければ invalid（口の名前だけ出し、式は出さない）", { skip }, async () => {
  // 先頭の " が落ちた結果メッセージ（S3 で実際に書かれた形）
  const broken = 'この顧客を集計しました（書き込み " & _result_total & " 件）';
  const r = await core.checkConfig(envelope(formulaAction({ resultMessage: broken })), { pluginZip: ZIP });
  assert.equal(r.status, "invalid", JSON.stringify(r.findings));
  const f = r.findings.find((x) => x.code === "pFormulaSyntax");
  assert.ok(f, JSON.stringify(r.findings));
  assert.match(f.message, /resultMessage/);
  assert.equal(f.actionCode, "f1");
  assert.equal(JSON.stringify(r).includes("この顧客を集計しました"), false, "式そのものが findings に出ている");
});

test("checkConfig: 項目名・関数名は構文の検査で誤りにしない（項目定義は段階 3）", { skip }, async () => {
  const r = await core.checkConfig(envelope(formulaAction({
    showCond: '処理状況 <> "済"',
    execCond: 'LEN(顧客コード) > 0',
    resultMessage: '"書き込み " & _result_total & " 件"',
  })), { pluginZip: ZIP });
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
});

test("checkConfig: 分ける式の構文も見る（保存のときダイアログを通らない）", { skip }, async () => {
  const r = await core.checkConfig(envelope(formulaAction({
    type: "list", placements: ["index_panel"], selectionMode: "group", groupFormula: 'IF(顧客コード <> "", "A", "B"',
    params: [], sql: "-- @ksql dialect: 1\nDECLARE @_group = '';\nDECLARE @_selected = [];\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 顧客コード = @_group AND $id IN @_selected;",
  })), { pluginZip: ZIP });
  assert.equal(r.status, "invalid");
  assert.ok(r.findings.some((f) => f.code === "pFormulaSyntax" && /groupFormula/.test(f.message)), JSON.stringify(r.findings));
});

// 引用符を忘れた素の文は警告（2026-10-28 Takashi「警告を足す」。試用 S4 の execNgMessage）
test("checkConfig: 引用符の無い素の文は警告（保存は止めない）", { skip }, async () => {
  const r = await core.checkConfig(envelope(formulaAction({
    execCond: '顧客コード <> ""',
    execNgMessage: "顧客コードが空のため集計できません。顧客コードを入れてください。",
  })), { pluginZip: ZIP });
  assert.equal(r.status, "ok", JSON.stringify(r.findings));  // warning なので ok
  const w = r.findings.find((f) => f.code === "pFormulaQuote");
  assert.ok(w, JSON.stringify(r.findings));
  assert.equal(w.level, "warning");
  assert.match(w.message, /execNgMessage/);
  assert.equal(JSON.stringify(r).includes("顧客コードが空のため"), false, "式そのものが findings に出ている");
});

test("checkConfig: 本物の項目コードは警告にしない（項目定義は段階 3）", { skip }, async () => {
  const r = await core.checkConfig(envelope(formulaAction({
    showCond: "処理状況",
    execCond: "顧客コード <> \"\"",
    resultMessage: '"書き込み " & _result_total & " 件"',
  })), { pluginZip: ZIP });
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.equal(r.findings.length, 0, JSON.stringify(r.findings));
});
