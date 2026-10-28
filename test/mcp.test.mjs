// MCP サーバーの試験: 実際に stdio で起動し、SDK の client からツールを呼ぶ。
// 使い方: npm test（先に npm run build が要る）
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ZIP = "/Users/rex0220/Projects/kintone-plugin/ksql-action/dist/ksql-action-plugin1.zip";
const skip = !existsSync(ZIP) || !existsSync("dist/mcp.mjs");

// 作業フォルダー（設定ファイルを 1 つ置く）
const ws = mkdtempSync(join(tmpdir(), "kact-ws-"));
const config = {
  date: "2026-10-28 00:00", pluginName: "kSQL アクション", pluginID: "rex0220 ksql action",
  PluginVersion: "1", appId: 4377, appName: "受注",
  configVersion: 1,
  bindings: [{ name: "受注", appId: 4377 }],
  limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
  timezone: "",
  actions: [{
    enabled: true, code: "mark", name: "印を付ける", description: "", type: "record", placements: ["detail_menu"],
    targetViews: [], showCond: "", execCond: "", execNgMessage: "", params: [{ name: "cust", source: "formula", formula: "顧客コード" }], inputs: [],
    sql: "-- @ksql dialect: 1\nDECLARE @cust = '';\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 顧客コード = @cust;",
    staticInsertRows: 0, confirm: true, writeLimit: 0, allowed: [], resultMessage: "",
    listOnError: "continue", selectionMode: "loop", groupFormula: "", perRecordLock: false, prevRecord: false,
  }],
};
writeFileSync(join(ws, "settings.json"), JSON.stringify(config));
writeFileSync(join(ws, "broken.json"), "{ これは JSON ではない");

let client;
let transport;
before(async () => {
  if (skip) return;
  client = new Client({ name: "test", version: "0" });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/mcp.mjs", "--surface", "claude-code"],
    env: { ...process.env, KACT_PLUGIN_ZIP: ZIP, KACT_WORKSPACE: ws },
  });
  await client.connect(transport);
});
after(async () => {
  await client?.close();
  await transport?.close();
});
const call = async (client, name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

test("ツールが 5 本出る（読み取り専用の注釈つき）", { skip }, async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["kact_actions", "kact_check", "kact_docs", "kact_status", "kact_workspace_status"]);
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, `${t.name} に readOnlyHint が無い`);
});

test("kact_status: zip の版と API の版を返す", { skip }, async () => {
  const r = await call(client, "kact_status");
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.equal(r.plugin.apiVersion, 1);
  assert.equal(r.plugin.formulaEngine, true);
  assert.equal(r.surface, "claude-code");
});

test("kact_workspace_status: 作業フォルダーと JSON の名前", { skip }, async () => {
  const r = await call(client, "kact_workspace_status");
  assert.equal(r.status, "ok");
  assert.ok(r.files.includes("settings.json"));
  assert.equal(r.pluginZipConfigured, true);
});

test("kact_check: 正しい設定は ok", { skip }, async () => {
  const r = await call(client, "kact_check", { file: "settings.json" });
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.equal(r.summary.actions, 1);
});

test("kact_check: 壊れた JSON は invalid", { skip }, async () => {
  const r = await call(client, "kact_check", { file: "broken.json" });
  assert.equal(r.status, "invalid");
});

test("作業フォルダーの外は読めない（絶対パス・..・symlink）", { skip }, async () => {
  for (const file of ["/etc/hosts", "../settings.json", "..\\settings.json"]) {
    const r = await call(client, "kact_check", { file });
    assert.equal(r.status, "invalid", `${file} が読めてしまった`);
    assert.ok(["outside", "not-found"].includes(r.findings[0].code), JSON.stringify(r.findings));
  }
});

test("kact_actions: 一覧に SQL 本文が混ざらない", { skip }, async () => {
  const r = await call(client, "kact_actions", { file: "settings.json" });
  assert.equal(r.status, "ok");
  assert.equal(r.actions[0].code, "mark");
  assert.equal(JSON.stringify(r).includes("LAPP_受注"), false);
});

// kact_docs は JSON ではなく文章を返す（text で受ける）
const callText = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;

test("kact_docs: 引数なしで目次（章の一覧と決まり）", { skip }, async () => {
  const t = await callText("kact_docs");
  assert.match(t, /章（kact_docs の section）:/);
  for (const key of ["navi", "howto-new", "howto-edit", "config", "sql", "patterns", "apply", "selection", "formula", "limits", "deploy"]) {
    assert.match(t, new RegExp(`^- ${key} — `, "m"), `目次に ${key} が無い`);
  }
  assert.match(t, /kintone には書き込まない/);
});

test("kact_docs: section でその章を返す", { skip }, async () => {
  const t = await callText("kact_docs", { section: "apply" });
  assert.match(t, /^apply — /);
  assert.match(t, /REMOVE ALL ROWS/);
});

test("kact_docs: 知らない section は invalid（使える名前を返す）", { skip }, async () => {
  const r = JSON.parse(await callText("kact_docs", { section: "nope" }));
  assert.equal(r.status, "invalid");
  assert.equal(r.findings[0].code, "unknown-section");
  assert.match(r.findings[0].message, /selection/);
});

test("kact_docs: query で合う節だけを返す", { skip }, async () => {
  const t = await callText("kact_docs", { query: "REMOVE ALL ROWS" });
  assert.match(t, /に合う節 \d+ 件/);
  assert.match(t, /## apply/);
  const none = await callText("kact_docs", { query: "この言葉はどこにも無い文字列" });
  assert.match(none, /合う節は無い/);
});

test("kact_status: tools の版と対応する API の版を返す", { skip }, async () => {
  const r = await call(client, "kact_status");
  assert.equal(r.tools.mode, "build");
  assert.deepEqual(r.tools.supportedApiVersions, [1]);
  assert.equal(r.tools.pluginId, "afkekkiffjhdkcepekecalklafjhbcmf");
});
