// 段階 3（kact_fields / kact_apps と、項目定義つきの計算式の検査）の試験。
// kintone には通信しない（fetch を差し替える）。使い方: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ZIP = process.env.KACT_PLUGIN_ZIP?.trim() || fileURLToPath(new URL("../../ksql-action/dist/ksql-action-plugin1.zip", import.meta.url));
const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
mkdirSync("dist", { recursive: true });
for (const name of ["fields", "core"]) {
  await esbuild.build({ entryPoints: [`src/${name}.ts`], bundle: true, format: "esm", platform: "node", outfile: `dist/${name}.test-bundle.mjs`, external: ["happy-dom"], logLevel: "warning" });
}
const fields = await import(pathToFileURL("dist/fields.test-bundle.mjs").href);
const core = await import(pathToFileURL("dist/core.test-bundle.mjs").href);

const skip = !existsSync(ZIP);

// 作業フォルダー（控えの置き場所）と、作業フォルダーの外に置く接続のファイル
const ws = mkdtempSync(join(tmpdir(), "kact-fields-"));
const outside = mkdtempSync(join(tmpdir(), "kact-conn-"));
const configFile = join(outside, "kintone-connections.json");
writeFileSync(configFile, JSON.stringify({
  defaultProfile: "dev",
  profiles: {
    dev: { baseUrl: "https://example.cybozu.com", tokenMap: { APP1001: "env:KACT_TEST_TOKEN" } },
    userpass: { baseUrl: "https://example.cybozu.com", username: "u", password: "p" },
  },
}));
const env = { KACT_TEST_TOKEN: "t0ken", KACT_WORKSPACE: ws };
const opt = (over = {}) => ({ configFile, env, workspaceDir: ws, ...over });

/** fetch の差し替え（送った URL とヘッダーの名前を控える。値は控えない） */
function stubFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method, headerNames: Object.keys(init.headers).sort() });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = key ? routes[key] : { code: "GAIA_AP01", message: "not found" };
    const text = JSON.stringify(body);
    return {
      ok: !!key,
      status: key ? 200 : 404,
      headers: { get: () => String(Buffer.byteLength(text)) },
      body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : ((done = true), { done: false, value: new TextEncoder().encode(text) })), cancel: async () => {} }; } },
    };
  };
  return { impl, calls };
}

const PROPERTIES = {
  顧客コード: { type: "SINGLE_LINE_TEXT", code: "顧客コード", label: "顧客コード", unique: true },
  金額: { type: "NUMBER", code: "金額", label: "金額" },
  明細: { type: "SUBTABLE", code: "明細", label: "明細", fields: { 担当者: { type: "SINGLE_LINE_TEXT", code: "担当者", label: "担当者" } } },
};

test("fetchFields: GET だけで項目定義を取り、控えに置いて要約を返す", { skip }, async () => {
  const { impl, calls } = stubFetch({ "app.json": { name: "受注" }, "app/form/fields.json": { properties: PROPERTIES, revision: "7" } });
  const r = await fields.fetchFields({ app: 1001 }, opt({ fetchImpl: impl }));
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.equal(r.appName, "受注");
  assert.equal(r.revision, "7");
  assert.equal(r.path, "fields/dev/APP1001.json");
  // 親 3 + テーブルの子 1
  assert.equal(r.count, 4);
  assert.deepEqual(r.fields.find((f) => f.code === "顧客コード"), { code: "顧客コード", type: "SINGLE_LINE_TEXT", label: "顧客コード", unique: true });
  assert.deepEqual(r.fields.find((f) => f.code === "担当者"), { code: "担当者", type: "SINGLE_LINE_TEXT", label: "担当者", table: "明細" });
  // 控えが置かれている（properties はそのまま）
  const saved = JSON.parse(readFileSync(join(ws, "fields/dev/APP1001.json"), "utf8"));
  assert.equal(saved.tool, "kact fields");
  assert.equal(saved.properties.金額.type, "NUMBER");
  // 送ったのは GET の 2 本だけ。トークンのヘッダーを使っている（値は見ない）
  assert.deepEqual(calls.map((c) => c.method), ["GET", "GET"]);
  assert.ok(calls.every((c) => c.headerNames.includes("X-Cybozu-API-Token")));
  assert.ok(calls.every((c) => c.url.startsWith("https://example.cybozu.com/k/v1/")));
});

test("fetchFields: 許さない API は送らない（レコードは読まない）", { skip }, async () => {
  const { impl } = stubFetch({});
  // record / records は ALLOWED_APIS に無いので、呼ぶ口自体が無い（型でも弾かれる）。ここでは 404 を失敗として返すことを見る
  const r = await fields.fetchFields({ app: 1001 }, opt({ fetchImpl: impl }));
  assert.equal(r.status, "failed");
  assert.ok(r.findings.some((f) => f.code === "kintone"), JSON.stringify(r.findings));
  assert.equal(JSON.stringify(r).includes("t0ken"), false, "トークンの値が返りに混ざっている");
});

test("接続: 作業フォルダーの中の接続のファイルは denied", { skip }, async () => {
  const inside = join(ws, "kintone-connections.json");
  writeFileSync(inside, readFileSync(configFile, "utf8"));
  const r = await fields.fetchFields({ app: 1001 }, opt({ configFile: inside }));
  assert.equal(r.status, "denied");
  assert.ok(r.findings[0].code.startsWith("connection-inside-workspace"), JSON.stringify(r.findings));
});

test("接続: 無い profile は invalid、トークンの無いアプリは no-token", { skip }, async () => {
  const bad = await fields.fetchFields({ app: 1001, profile: "nosuch" }, opt());
  assert.equal(bad.status, "invalid");
  const noToken = await fields.fetchFields({ app: 4242 }, opt());
  assert.equal(noToken.status, "failed");
  assert.ok(noToken.findings[0].code === "connection-no-token", JSON.stringify(noToken.findings));
});

test("listApps: API トークンの profile では一覧を読めない（理由を返す）", { skip }, async () => {
  const r = await fields.listApps({}, opt());
  assert.equal(r.status, "invalid");
  assert.equal(r.findings[0].code, "token-cannot-list");
  assert.match(r.findings[0].message, /1001/);
});

test("listApps: ログイン名とパスワードの profile では一覧を返す", { skip }, async () => {
  const { impl, calls } = stubFetch({ "apps.json": { apps: [{ appId: "1001", name: "受注", spaceId: "364" }] } });
  const r = await fields.listApps({ profile: "userpass" }, opt({ fetchImpl: impl }));
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.deepEqual(r.apps, [{ appId: 1001, name: "受注", spaceId: 364 }]);
  assert.ok(calls[0].headerNames.includes("X-Cybozu-Authorization"));
});

// --- 項目定義つきの計算式の検査（kact_check の段階 3） ---

const envelope = (over = {}) => JSON.stringify({
  date: "2026-10-28 00:00", pluginName: "kSQL アクション", pluginID: "rex0220 ksql action",
  PluginVersion: "1", appId: 1001, appName: "受注",
  configVersion: 1,
  bindings: [{ name: "受注", appId: 1001 }],
  limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
  timezone: "",
  actions: [{
    enabled: true, code: "f1", name: "式の試験", description: "", type: "record", placements: ["detail_menu"],
    targetViews: [], showCond: "", execCond: "", execNgMessage: "",
    params: [{ name: "cust", source: "formula", formula: "顧客コード" }], inputs: [],
    sql: "-- @ksql dialect: 1\nDECLARE @cust = '';\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 顧客コード = @cust;",
    staticInsertRows: 0, confirm: true, writeLimit: 0, allowed: [], resultMessage: "",
    listOnError: "continue", selectionMode: "loop", groupFormula: "", perRecordLock: false, prevRecord: false,
    ...over,
  }],
});

test("checkConfig: 項目定義を渡すと項目コードの誤りを error で返す", { skip }, async () => {
  const r = await core.checkConfig(envelope({ showCond: '顧客コード <> ""', execCond: '無い項目 <> ""' }), { pluginZip: ZIP, fields: PROPERTIES });
  assert.equal(r.summary?.formulaCheck ?? "(なし)", "fields");
  assert.equal(r.status, "invalid", JSON.stringify(r.findings));
  const f = r.findings.find((x) => x.code === "pFormulaField");
  assert.ok(f, JSON.stringify(r.findings));
  assert.match(f.message, /execCond/);
  assert.match(f.message, /無い項目/);
});

test("checkConfig: 項目定義があれば正しい式は ok（テーブルの子も使える）", { skip }, async () => {
  const r = await core.checkConfig(envelope({ showCond: '顧客コード <> ""', resultMessage: '"書き込み " & _result_total & " 件"' }), { pluginZip: ZIP, fields: PROPERTIES });
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.equal(r.summary.formulaCheck, "fields");
});

test("checkConfig: 項目定義が無ければ構文だけ（formulaCheck = syntax）", { skip }, async () => {
  const r = await core.checkConfig(envelope({ execCond: '無い項目 <> ""' }), { pluginZip: ZIP });
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.equal(r.summary.formulaCheck, "syntax");
});

test("checkConfig: レコード文脈が無いアクション（アプリ種別）では項目参照が誤りになる", { skip }, async () => {
  const r = await core.checkConfig(envelope({
    type: "app", placements: ["index_menu"], showCond: '顧客コード <> ""',
    params: [], sql: "-- @ksql dialect: 1\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 処理状況 = '';",
  }), { pluginZip: ZIP, fields: PROPERTIES });
  assert.equal(r.status, "invalid", JSON.stringify(r.findings));
  assert.ok(r.findings.some((f) => f.code === "pFormulaField" && /showCond/.test(f.message)), JSON.stringify(r.findings));
});

test("findFieldsFile: profile が分からなくても控えを見つける", { skip }, async () => {
  const found = fields.findFieldsFile(1001, ws);
  assert.ok(found, "控えが見つからない");
  assert.equal(found.path, "fields/dev/APP1001.json");
  assert.equal(found.file.appId, 1001);
  assert.equal(fields.findFieldsFile(9999, ws), undefined);
});

test("connectionReport: 読めた profile の形だけを返す（秘密の値もパスも出さない）", { skip }, async () => {
  const r = fields.connectionReport(opt());
  assert.equal(r.report.configured, true);
  assert.equal(r.report.fileName, "kintone-connections.json");
  assert.equal(r.report.defaultProfile, "dev");
  const dev = r.report.profiles.find((p) => p.profile === "dev");
  assert.equal(dev.host, "example.cybozu.com");
  assert.equal(dev.auth, "token");
  assert.deepEqual(dev.tokenApps, [1001]);
  assert.equal(dev.tokenReady[1001], true);
  const text = JSON.stringify(r);
  assert.equal(text.includes("t0ken"), false, "トークンの値が出ている");
  assert.equal(text.includes(outside), false, "接続のファイルのパスが出ている");
  assert.equal(text.includes("KACT_TEST_TOKEN"), false, "環境変数の名前が出ている");
});

test("connectionReport: 設定が無ければ configured: false（検査と保存は使える）", { skip }, async () => {
  const r = fields.connectionReport({ env, workspaceDir: ws });
  assert.equal(r.report.configured, false);
  assert.equal(r.findings[0].code, "connection-not-configured");
  assert.equal(r.findings[0].level, "info");
});
