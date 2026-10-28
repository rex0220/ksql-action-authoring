// 保存（段階 2）の試験: 実際の zip と一時の作業フォルダーで、save / update / pull / files / diff を確かめる。
// 使い方: npm test（zip が無ければ skip）
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
for (const name of ["save", "diff"]) {
  await esbuild.build({ entryPoints: [`src/${name}.ts`], bundle: true, format: "esm", platform: "node", outfile: `dist/${name}.test-bundle.mjs`, external: ["happy-dom"], logLevel: "warning" });
}
const save = await import(pathToFileURL("dist/save.test-bundle.mjs").href);
const { diffConfigs } = await import(pathToFileURL("dist/diff.test-bundle.mjs").href);

const skip = !existsSync(ZIP);
const opt = { pluginZip: ZIP };

// 作業フォルダーは呼ぶときの環境変数で決まる（AI の引数では変えられない）
const ws = mkdtempSync(join(tmpdir(), "kact-save-"));
process.env.KACT_WORKSPACE = ws;

const action = (over = {}) => ({
  code: "sum",
  name: "集計する",
  type: "record",
  placements: ["detail_menu"],
  params: [{ name: "cust", source: "formula", formula: "顧客コード" }],
  sql: "-- @ksql dialect: 1\nDECLARE @cust = '';\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 顧客コード = @cust;",
  ...over,
});
const config = (over = {}) => ({ bindings: [{ name: "受注", appId: 1001 }], actions: [action()], ...over });

test("saveConfig: 検査を通る設定を保存する（既定値で埋まる・封筒が付く）", { skip }, async () => {
  const r = await save.saveConfig({ file: "settings/kact-1001.json", appId: 1001, appName: "受注", config: config() }, opt);
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.equal(r.path, "settings/kact-1001.json");
  assert.match(r.digest, /^[0-9a-f]{64}$/);
  assert.equal(r.summary.actions, 1);
  const text = readFileSync(join(ws, "settings/kact-1001.json"), "utf8");
  assert.equal(text.split("\n").length, 1, "1 行の JSON で書く");
  const env = JSON.parse(text);
  assert.equal(env.pluginID, "rex0220 ksql action");
  assert.equal(env.appId, 1001);
  // 渡していないキーが既定値で埋まっている
  assert.equal(env.configVersion, 1);
  assert.equal(env.limits.applySubtableMax, 500);
  assert.equal(env.actions[0].confirm, true);
  assert.equal(env.actions[0].selectionMode, "loop");
  assert.equal(env.actions[0].staticInsertRows, 0);
});

test("saveConfig: 同じ名前は上書きしない（conflict）", { skip }, async () => {
  const r = await save.saveConfig({ file: "settings/kact-1001.json", appId: 1001, config: config() }, opt);
  assert.equal(r.status, "conflict");
  assert.equal(r.findings[0].code, "exists");
});

test("saveConfig: 検査を通らない設定は書かない", { skip }, async () => {
  const bad = config({ actions: [action({ code: "bad", sql: "-- @ksql dialect: 1\nSELECT 顧客コード FROM LAPP_受注;" })] });
  const r = await save.saveConfig({ file: "settings/bad.json", appId: 1001, config: bad }, opt);
  assert.equal(r.status, "invalid");
  assert.ok(r.findings.some((f) => f.code === "pStatement"), JSON.stringify(r.findings));
  assert.equal(existsSync(join(ws, "settings/bad.json")), false, "書いていない");
});

test("saveConfig: 作業フォルダーの外は denied", { skip }, async () => {
  for (const file of ["/tmp/kact-outside.json", "../outside.json", "settings/../../outside.json"]) {
    const r = await save.saveConfig({ file, appId: 1001, config: config() }, opt);
    assert.equal(r.status, "denied", `${file} が denied でない: ${JSON.stringify(r)}`);
  }
  assert.equal(existsSync("/tmp/kact-outside.json"), false);
});

test("saveConfig: appId が無ければ invalid（推測しない）", { skip }, async () => {
  const r = await save.saveConfig({ file: "settings/no-app.json", appId: 0, config: config() }, opt);
  assert.equal(r.status, "invalid");
  assert.equal(existsSync(join(ws, "settings/no-app.json")), false);
});

test("updateAction: digest が合えば差し替える", { skip }, async () => {
  const before = readFileSync(join(ws, "settings/kact-1001.json"), "utf8");
  const digest = save.digestOf(before);
  const r = await save.updateAction({ file: "settings/kact-1001.json", expectedDigest: digest, action: action({ name: "集計する（直した）", writeLimit: 50 }) }, opt);
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.notEqual(r.digest, digest);
  const env = JSON.parse(readFileSync(join(ws, "settings/kact-1001.json"), "utf8"));
  assert.equal(env.actions.length, 1);
  assert.equal(env.actions[0].name, "集計する（直した）");
  assert.equal(env.actions[0].writeLimit, 50);
});

test("updateAction: digest が違えば conflict（書かない）", { skip }, async () => {
  const before = readFileSync(join(ws, "settings/kact-1001.json"), "utf8");
  const r = await save.updateAction({ file: "settings/kact-1001.json", expectedDigest: "0".repeat(64), action: action({ name: "入れ替わらない" }) }, opt);
  assert.equal(r.status, "conflict");
  assert.equal(r.findings[0].code, "digest");
  assert.equal(readFileSync(join(ws, "settings/kact-1001.json"), "utf8"), before);
});

test("updateAction: 無いコードは末尾に足す", { skip }, async () => {
  const digest = save.digestOf(readFileSync(join(ws, "settings/kact-1001.json"), "utf8"));
  const r = await save.updateAction({ file: "settings/kact-1001.json", expectedDigest: digest, action: action({ code: "close", name: "締める" }) }, opt);
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  const env = JSON.parse(readFileSync(join(ws, "settings/kact-1001.json"), "utf8"));
  assert.deepEqual(env.actions.map((a) => a.code), ["sum", "close"]);
});

test("updateAction: 検査を通らない差し替えは書かない", { skip }, async () => {
  const before = readFileSync(join(ws, "settings/kact-1001.json"), "utf8");
  const digest = save.digestOf(before);
  // 確認なしで書き込み上限が無い = 保存時エラー（本体の validateConfig と同じ規則）
  const r = await save.updateAction({ file: "settings/kact-1001.json", expectedDigest: digest, action: action({ confirm: false, writeLimit: 0 }) }, opt);
  assert.equal(r.status, "invalid");
  assert.ok(r.findings.some((f) => f.message.includes("writeLimit")), JSON.stringify(r.findings));
  assert.equal(readFileSync(join(ws, "settings/kact-1001.json"), "utf8"), before);
});

test("pullConfig: ダウンロードした設定を写す（元は残す）", { skip }, async () => {
  mkdirSync(join(ws, "inbox"), { recursive: true });
  const downloaded = readFileSync(join(ws, "settings/kact-1001.json"), "utf8");
  writeFileSync(join(ws, "inbox/kact-download.json"), downloaded);
  const r = await save.pullConfig({ from: "inbox/kact-download.json" }, opt);
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.equal(r.path, "settings/APP1001.json");
  assert.equal(readFileSync(join(ws, "settings/APP1001.json"), "utf8"), downloaded);
  assert.equal(existsSync(join(ws, "inbox/kact-download.json")), true, "元のファイルは残す");
  const again = await save.pullConfig({ from: "inbox/kact-download.json" }, opt);
  assert.equal(again.status, "conflict");
});

test("pullConfig: kSQL アクションの設定でなければ写さない", { skip }, async () => {
  writeFileSync(join(ws, "inbox/other.json"), JSON.stringify({ pluginID: "rex0220 other plugin", actions: [] }));
  const r = await save.pullConfig({ from: "inbox/other.json", to: "settings/other.json" }, opt);
  assert.equal(r.status, "invalid");
  assert.equal(r.findings[0].code, "parse-failed");
  assert.equal(existsSync(join(ws, "settings/other.json")), false);
});

test("filesOf: 設定ファイルは digest とアクションの数が付く", { skip }, async () => {
  const r = await save.filesOf(opt);
  assert.equal(r.status, "ok");
  const main = r.files.find((f) => f.path === "settings/kact-1001.json");
  assert.ok(main, JSON.stringify(r.files));
  assert.equal(main.kact, true);
  assert.equal(main.actions, 2);
  assert.equal(main.appId, 1001);
  assert.match(main.digest, /^[0-9a-f]{64}$/);
  const other = r.files.find((f) => f.path === "inbox/other.json");
  assert.equal(other.kact, false);
  assert.equal(other.digest, undefined);
});

test("diffConfigs: アクションの追加と SQL の行の差分", { skip }, async () => {
  const before = { pluginID: "rex0220 ksql action", appId: 1001, actions: [{ code: "sum", name: "集計", sql: "line1\nline2" }], limits: { readMax: 10000 } };
  const after = { pluginID: "rex0220 ksql action", appId: 1001, actions: [{ code: "sum", name: "集計（直した）", sql: "line1\nline2x" }, { code: "close", name: "締める", type: "app" }], limits: { readMax: 20000 } };
  const d = diffConfigs(before, after);
  assert.match(d, /共通設定 \/ 制限 \/ readMax: 10000 → 20000/);
  assert.match(d, /アクション sum \/ name: 集計 → 集計（直した）/);
  assert.match(d, /アクション sum \/ sql:/);
  assert.match(d, /^- line2$/m);
  assert.match(d, /^\+ line2x$/m);
  assert.match(d, /アクション close: 追加/);
  assert.equal(diffConfigs(before, before), "");
});
