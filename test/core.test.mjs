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
  assert.equal(r.plugin.apiVersion, 1);
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
