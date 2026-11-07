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
for (const name of ["save", "diff", "core"]) {
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

// 2026-11-06 の試用 S2: 種類 app のアクションを「変えるところだけ」書いて保存すると、
// 既定の placements（["detail_menu"]）が当たって必ず action[0]:app:placement で落ちた
test("saveConfig: 種類 app は placements を書かなくても保存できる（既定の detail_menu を当てない）", { skip }, async () => {
  const appAction = {
    code: "agg",
    name: "集計する",
    type: "app",
    panelSection: "集計",
    params: [],
    sql: "-- @ksql dialect: 1\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 処理状況 = '';",
  };
  const cfg = {
    bindings: [{ name: "受注", appId: 1001 }],
    panel: {
      title: "", sectionColumns: 1, buttonWidth: 200, buttonLogLink: false,
      sections: [{ enabled: true, name: "集計", color: "blue", tone: "soft", collapsed: false }],
      views: [{ viewId: "*", sections: ["集計"], menus: [], open: false }],
    },
    actions: [appAction],
  };
  const r = await save.saveConfig({ file: "settings/kact-app-type.json", appId: 1001, config: cfg }, opt);
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  const env = JSON.parse(readFileSync(join(ws, "settings/kact-app-type.json"), "utf8"));
  assert.deepEqual(env.actions[0].placements, [], "種類 app の placements が空になっていない");

  // 自分で detail_menu と書いたなら、それは誤りとして落とす（埋めるのは書いていないときだけ）
  const wrong = await save.saveConfig(
    { file: "settings/kact-app-type-wrong.json", appId: 1001, config: { ...cfg, actions: [{ ...appAction, placements: ["detail_menu"] }] } },
    opt,
  );
  assert.equal(wrong.status, "invalid");
  assert.ok(wrong.findings.some((f) => f.message.includes("app:placement")), JSON.stringify(wrong.findings));
  // 規則のコードだけでは直せないので、読み方を添える
  assert.ok(wrong.findings.some((f) => f.message.includes("kact_docs")), JSON.stringify(wrong.findings));
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

// 2026-11-06 の試用 S3: 古い控えをそのまま取り込むと区分が消えるのに、
// 取り込む前に読む kact_diff が panel を一度も比べていなかった
test("diffConfigs: パネル・区分（区分の増減と 画面 × 区分 の表）も出す", () => {
  const sec = (name, over = {}) => ({ enabled: true, name, color: "blue", tone: "soft", collapsed: false, ...over });
  const panel = (sections, views, over = {}) => ({ title: "", sectionColumns: 1, buttonWidth: 200, buttonLogLink: false, sections, views, ...over });
  const env = (p) => ({ pluginID: "rex0220 ksql action", appId: 1001, actions: [], panel: p });

  const before = env(panel([sec("注文")], [
    { viewId: "detail", sections: [], menus: [], open: false },
    { viewId: "*", sections: ["注文"], menus: [], open: false },
  ]));
  const after = env(panel([sec("注文"), sec("保守")], [
    { viewId: "detail", sections: [], menus: ["保守"], open: false },
    { viewId: "*", sections: ["注文"], menus: ["保守"], open: true },
    { viewId: "1102", sections: [], menus: [], open: false, enabled: false },
  ], { buttonWidth: 120 }));

  const d = diffConfigs(before, after);
  assert.match(d, /共通設定 \/ 区分: 注文 → 注文, 保守/);
  assert.match(d, /共通設定 \/ パネル・区分 \/ buttonWidth: 200 → 120/);
  assert.match(d, /画面ごとの出し方 \/ 詳細画面:/);
  assert.match(d, /画面ごとの出し方 \/ ほかの一覧すべて:.*開いて出す/);
  assert.match(d, /画面ごとの出し方 \/ 一覧 1102: （無し） → 無効/);
  assert.equal(diffConfigs(before, before), "");

  // 無効の区分と「区分なし」も読める形で出す
  const d2 = diffConfigs(env(panel([sec("注文")], [])), env(panel([sec("注文", { enabled: false })], [])));
  assert.match(d2, /共通設定 \/ 区分: 注文 → 注文（無効）/);
  const d3 = diffConfigs(
    env(panel([sec("注文")], [{ viewId: "*", sections: [""], menus: [], open: false }])),
    env(panel([sec("注文")], [{ viewId: "*", sections: [], menus: [""], open: false }])),
  );
  assert.match(d3, /パネル: （区分なし）/);
});

// 2026-11-06 の試用 S3 の再実施: ツールは params[].enabled をわざと埋めない（古い zip が断る）ので、
// 設定画面を一往復しただけで「変わった」と出ていた
test("diffConfigs: params / inputs の enabled: true は省略と同じに見る", () => {
  const env = (actions) => ({ pluginID: "rex0220 ksql action", appId: 1001, actions });
  const act = (params) => [{ code: "sum", name: "集計", params }];
  const noKey = env(act([{ name: "now", source: "formula", formula: "NOW()" }]));
  const withTrue = env(act([{ enabled: true, name: "now", source: "formula", formula: "NOW()" }]));
  const withFalse = env(act([{ enabled: false, name: "now", source: "formula", formula: "NOW()" }]));

  assert.equal(diffConfigs(noKey, withTrue), "", "enabled: true を足しただけで差分が出ている");
  assert.equal(diffConfigs(withTrue, noKey), "");
  assert.match(diffConfigs(noKey, withFalse), /params:/, "enabled: false は意味があるので出す");

  // inputs も同じ
  const inp = (inputs) => env([{ code: "sum", name: "集計", inputs }]);
  assert.equal(
    diffConfigs(inp([{ name: "m", label: "月", type: "text" }]), inp([{ enabled: true, name: "m", label: "月", type: "text" }])),
    "",
  );
});

// loopMax / runMax は 2026-11-05 にループと一緒に足した項目。差分から漏れていた
test("diffConfigs: 制限の loopMax / runMax と progressStyle も出す", () => {
  const env = (over) => ({ pluginID: "rex0220 ksql action", appId: 1001, actions: [], ...over });
  const d = diffConfigs(
    env({ limits: { loopMax: 100, runMax: 1000 }, progressStyle: "dialog" }),
    env({ limits: { loopMax: 10, runMax: 50 }, progressStyle: "spinner" }),
  );
  assert.match(d, /制限 \/ loopMax: 100 → 10/);
  assert.match(d, /制限 \/ runMax: 1000 → 50/);
  assert.match(d, /共通設定 \/ progressStyle: dialog → spinner/);
});

// 2026-10-28 の試用 S2 で落ちた形: inputs / params の中のキーを省いて渡す
test("saveConfig: inputs と params の中のキーも既定値で埋まる（options を書かなくてよい）", { skip }, async () => {
  const withInput = action({
    code: "memo",
    params: [
      { name: "cust", source: "formula", formula: "顧客コード" },
      { name: "memo", source: "input" },                           // formula を省く
    ],
    inputs: [{ name: "memo", label: "処理メモ", required: true }],   // type / defaultFormula / options を省く
    sql: "-- @ksql dialect: 1\nDECLARE @cust = '';\nDECLARE @memo = '';\nUPDATE LAPP_受注 SET 処理メモ = @memo WHERE 顧客コード = @cust;",
  });
  const r = await save.saveConfig({ file: "settings/kact-inputs.json", appId: 1001, config: config({ actions: [withInput] }) }, opt);
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  const env = JSON.parse(readFileSync(join(ws, "settings/kact-inputs.json"), "utf8"));
  const a = env.actions[0];
  assert.deepEqual(a.inputs[0], { name: "memo", label: "処理メモ", type: "text", required: true, defaultFormula: "", options: [] });
  assert.deepEqual(a.params[1], { name: "memo", source: "input", formula: "" });
});

test("saveConfig: inputs だけで params に行が無ければ invalid（書かない）", { skip }, async () => {
  const onlyInput = action({
    code: "memo2",
    inputs: [{ name: "memo", label: "処理メモ" }],
    sql: "-- @ksql dialect: 1\nDECLARE @cust = '';\nDECLARE @memo = '';\nUPDATE LAPP_受注 SET 処理メモ = @memo WHERE 顧客コード = @cust;",
  });
  const r = await save.saveConfig({ file: "settings/kact-only-input.json", appId: 1001, config: config({ actions: [onlyInput] }) }, opt);
  assert.equal(r.status, "invalid");
  assert.ok(r.findings.some((f) => f.code === "pParamMissing"), JSON.stringify(r.findings));
  assert.equal(existsSync(join(ws, "settings/kact-only-input.json")), false, "検査に落ちたのに書かれている");
});

// kact_update_action は同じファイルを書き替えるので、直したところの差を返す（2026-10-28 の試用 S3）
test("updateAction: 直したところの差（changes）を返す", { skip }, async () => {
  const first = await save.saveConfig({ file: "settings/kact-changes.json", appId: 1001, config: config() }, opt);
  assert.equal(first.status, "ok", JSON.stringify(first.findings));
  const r = await save.updateAction({
    file: "settings/kact-changes.json",
    expectedDigest: first.digest,
    action: { code: "sum", writeLimit: 10, sql: "-- @ksql dialect: 1\nDECLARE @cust = '';\n-- 直した\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 顧客コード = @cust;" },
  }, opt);
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.match(r.changes, /writeLimit: 0 → 10/);
  assert.match(r.changes, /^\+ -- 直した$/m);
});

test("updateAction: 足したときは「追加」を返す", { skip }, async () => {
  const files = await save.filesOf(opt);
  const digest = files.files.find((f) => f.path === "settings/kact-changes.json").digest;
  const r = await save.updateAction({
    file: "settings/kact-changes.json",
    expectedDigest: digest,
    action: { code: "added", name: "足した", type: "record", placements: ["detail_menu"], params: [], sql: "-- @ksql dialect: 1\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 処理状況 = '';" },
  }, opt);
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.match(r.changes, /アクション added: 追加/);
});

// キーの順だけが変わった差は出さない（既定値で埋め直すと順が変わる。2026-10-28 の試用 S4）
test("updateAction: 中身が同じ params / inputs は changes に出さない", { skip }, async () => {
  const first = await save.saveConfig({
    file: "settings/kact-order.json", appId: 1001,
    config: config({ actions: [action({ code: "ord", params: [{ formula: "顧客コード", name: "cust", source: "formula" }] })] }),
  }, opt);
  assert.equal(first.status, "ok", JSON.stringify(first.findings));
  // code と enabled だけ渡す（S4 の回が 5 回やった形）
  const r = await save.updateAction({ file: "settings/kact-order.json", expectedDigest: first.digest, action: { code: "ord", enabled: false } }, opt);
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.match(r.changes, /enabled: true → false/);
  assert.equal(/params:/.test(r.changes), false, `キーの順だけの差が出ている: ${r.changes}`);
  assert.equal(/inputs:/.test(r.changes), false, `キーの順だけの差が出ている: ${r.changes}`);
});

// アクションを消す口（2026-10-28 Takashi「足す」。試用 S4 で無効 5 回で代用していた）
test("deleteAction: digest が合えば消す（changes に削除が出る）", { skip }, async () => {
  const two = config({ actions: [action({ code: "keep" }), action({ code: "gone", name: "消す" })] });
  const first = await save.saveConfig({ file: "settings/kact-del.json", appId: 1001, config: two }, opt);
  assert.equal(first.status, "ok", JSON.stringify(first.findings));
  const r = await save.deleteAction({ file: "settings/kact-del.json", expectedDigest: first.digest, code: "GONE" }, opt);
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.equal(r.summary.actions, 1);
  assert.match(r.changes, /アクション gone: 削除/);
  const env = JSON.parse(readFileSync(join(ws, "settings/kact-del.json"), "utf8"));
  assert.deepEqual(env.actions.map((a) => a.code), ["keep"]);
});

test("deleteAction: digest が違えば conflict、無いコードは invalid、最後の 1 件は消せない", { skip }, async () => {
  const files = await save.filesOf(opt);
  const digest = files.files.find((f) => f.path === "settings/kact-del.json").digest;
  const bad = await save.deleteAction({ file: "settings/kact-del.json", expectedDigest: "0".repeat(64), code: "keep" }, opt);
  assert.equal(bad.status, "conflict");
  const missing = await save.deleteAction({ file: "settings/kact-del.json", expectedDigest: digest, code: "nosuch" }, opt);
  assert.equal(missing.status, "invalid");
  assert.ok(missing.findings.some((f) => f.code === "not-found"), JSON.stringify(missing.findings));
  const last = await save.deleteAction({ file: "settings/kact-del.json", expectedDigest: digest, code: "keep" }, opt);
  assert.equal(last.status, "invalid");
  assert.ok(last.findings.some((f) => f.code === "last-action"), JSON.stringify(last.findings));
  // どの失敗でもファイルは変わっていない
  assert.equal(JSON.parse(readFileSync(join(ws, "settings/kact-del.json"), "utf8")).actions.length, 1);
});

// 2026-11-07 の試用 S4 の再実施: 選択肢の定義に無い値の検査（choice-unknown。API 版 8）が
// **一度も鳴っていなかった**。保存と検査は自アプリの properties（キーは項目コード）を
// createFieldsClient に渡していて、getFields(アプリ番号) が throw → catch で黙って飛んでいた。
// SQL は**ほかのアプリ**の選択肢と比べるのがふつうなので、自アプリ 1 つでは足りない
test("saveConfig: ほかのアプリの選択肢に無い値で絞ると注意（choice-unknown）", { skip }, async () => {
  // 控えを 2 つ置く（受注 1001 = 選択肢つき、請求 1002 = 書き先）
  const cache = (appId, appName, properties) => {
    mkdirSync(join(ws, "fields/dev"), { recursive: true });
    writeFileSync(join(ws, `fields/dev/APP${appId}.json`), JSON.stringify({
      tool: "kact fields", fetchedAt: "2026-11-07T00:00:00.000Z", profile: "dev",
      host: "example.cybozu.com", appId, appName, revision: "1", preview: false, properties,
    }));
  };
  cache(1001, "受注", {
    請求対象: { type: "DROP_DOWN", code: "請求対象", label: "請求対象", options: { 対象: { label: "対象", index: "0" }, 対象外: { label: "対象外", index: "1" } } },
    顧客コード: { type: "SINGLE_LINE_TEXT", code: "顧客コード", label: "顧客コード" },
    金額: { type: "NUMBER", code: "金額", label: "金額" },
  });
  cache(1002, "請求", {
    請求キー: { type: "SINGLE_LINE_TEXT", code: "請求キー", label: "請求キー", unique: true },
    金額: { type: "NUMBER", code: "金額", label: "金額" },
  });

  const cfg = (value) => ({
    bindings: [{ name: "受注", appId: 1001 }, { name: "請求", appId: 1002 }],
    panel: { views: [{ viewId: "*", sections: [""], menus: [], open: false }] },
    actions: [{
      code: "agg", name: "集計する", type: "app", params: [], inputs: [],
      sql: "-- @ksql dialect: 1\nCREATE TEMP TABLE #a AS\n"
        + `SELECT 顧客コード, SUM(金額) AS 金額 FROM LAPP_受注 WHERE 請求対象 = '${value}' GROUP BY 顧客コード;\n`
        + "UPSERT INTO LAPP_請求 (請求キー, 金額) SELECT 顧客コード AS 請求キー, 金額 FROM #a ON DUPLICATE (請求キー);",
      confirm: true, writeLimit: 10,
    }],
  });

  // 選択肢に無い値 → 注意（保存は止めない）
  const bad = await save.saveConfig({ file: "settings/kact-choice-bad.json", appId: 1002, appName: "請求", config: cfg("対象外外") }, opt);
  assert.equal(bad.status, "ok", "注意なので保存は止めない");
  const w = bad.findings.find((f) => f.code === "choice-unknown");
  assert.ok(w, JSON.stringify(bad.findings));
  assert.match(w.message, /請求対象/);
  assert.match(w.message, /対象 \/ 対象外/, "選択肢を並べて見せる");

  // 選択肢にある値 → 出さない
  const ok = await save.saveConfig({ file: "settings/kact-choice-ok.json", appId: 1002, appName: "請求", config: cfg("対象") }, opt);
  assert.equal(ok.findings.filter((f) => f.code === "choice-unknown").length, 0, JSON.stringify(ok.findings));
});

// 2026-11-07 の試用 S8: replaceCode で改名すると、いちばん重い変更（コード＝ロックキーと
// ログの名前）が `changes` から落ちていた。`code` が ACTION_SCALARS に無いため
test("updateAction: replaceCode の改名は changes にコードの変更を出す", { skip }, async () => {
  const cfg = {
    bindings: [{ name: "受注", appId: 1001 }],
    actions: [
      { code: "keep", name: "残す", type: "app", params: [], sql: "-- @ksql dialect: 1\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 処理状況 = '';" },
      { code: "old_code", name: "集計を再計算", type: "app", panelSection: "", params: [], sql: "-- @ksql dialect: 1\nUPDATE LAPP_受注 SET 処理状況 = 'A' WHERE 処理状況 = '';" },
    ],
  };
  const saved = await save.saveConfig({ file: "settings/kact-rename.json", appId: 1001, appName: "受注", config: cfg }, opt);
  assert.equal(saved.status, "ok", JSON.stringify(saved.findings));

  const r = await save.updateAction({
    file: "settings/kact-rename.json",
    expectedDigest: saved.digest,
    replaceCode: "old_code",
    action: { code: "recalc", name: "recalc" },
  }, opt);
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.match(r.changes, /code: old_code → recalc/, "コードの変更を出す");
  assert.match(r.changes, /ロックキーとログの名前/, "何が起きるかを添える");
  assert.match(r.changes, /name: 集計を再計算 → recalc/, "ほかの変更も今までどおり出す");

  // 中身は保たれている（マージなので SQL も区分もそのまま）
  const env = JSON.parse(readFileSync(join(ws, "settings/kact-rename.json"), "utf8"));
  const renamed = env.actions.find((a) => a.code === "recalc");
  assert.ok(renamed, "改名後のコードで見つかる");
  assert.equal(env.actions.find((a) => a.code === "old_code"), undefined, "古いコードは残らない");
  assert.match(renamed.sql, /処理状況 = 'A'/, "SQL は保たれる");
  assert.equal(env.actions.map((a) => a.code).join(","), "keep,recalc", "並びも保たれる");

  // コードが変わっていなければ、その行は出ない
  const files2 = await save.filesOf(opt);
  const d2 = files2.files.find((f) => f.path === "settings/kact-rename.json").digest;
  const same = await save.updateAction({
    file: "settings/kact-rename.json", expectedDigest: d2,
    action: { code: "recalc", name: "再計算" },
  }, opt);
  assert.equal(same.status, "ok", JSON.stringify(same.findings));
  assert.ok(!/code:/.test(same.changes), `コードが同じなら出さない: ${same.changes}`);
});

// 2026-11-07 の Codex レビュー: 資料は「共通の文はツールからは足せない」と断言しているのに、
// 仕組みでは止まっていなかった（実測でツールが作ったコードが保存できた）。
// 取り込みは全置換なので、AI が作った文が利用者の書いた文を置き換えてしまう
test("saveConfig: 共通の文（messages）はツールからは足せない", { skip }, async () => {
  const cfg = (messages) => ({
    bindings: [{ name: "受注", appId: 1001 }],
    ...(messages ? { messages } : {}),
    actions: [{
      code: "m", name: "共通の文", type: "app", params: [],
      sql: "-- @ksql dialect: 1\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 処理状況 = '';",
    }],
  });

  const ng = await save.saveConfig({
    file: "settings/kact-msg-ng.json", appId: 1001, appName: "受注",
    config: cfg([{ code: "m_x", text: "文" }]),
  }, opt);
  assert.equal(ng.status, "invalid", JSON.stringify(ng.findings));
  assert.equal(ng.findings[0].code, "messages-not-writable");
  assert.match(ng.findings[0].message, /メッセージ/);
  assert.equal(existsSync(join(ws, "settings/kact-msg-ng.json")), false, "書いていない");

  // 封筒ごと渡しても同じ
  const wrapped = await save.saveConfig({
    file: "settings/kact-msg-ng2.json", appId: 1001, appName: "受注",
    config: { config: cfg([{ code: "m_x", text: "文" }]) },
  }, opt);
  assert.equal(wrapped.status, "invalid");
  assert.equal(wrapped.findings[0].code, "messages-not-writable");

  // 空なら今までどおり通る
  const ok = await save.saveConfig({
    file: "settings/kact-msg-ok.json", appId: 1001, appName: "受注", config: cfg(undefined),
  }, opt);
  assert.equal(ok.status, "ok", JSON.stringify(ok.findings));
});

// 2026-11-07 の Codex レビュー: 記録範囲（eventLog）と記録先（logApp の中身）が差分に出なかった。
// AI が利用者に見せる確認結果から、記録の方針と置き場所の変更が消えていた
test("diffConfigs: 記録範囲と記録先の変更が差分に出る", () => {
  const env = (eventLog, logAppOver) => ({
    date: "2026-11-07 00:00", pluginName: "kSQL アクション", pluginID: "rex0220 ksql action",
    PluginVersion: "1", appId: 1001, appName: "受注",
    configVersion: 1, bindings: [{ name: "受注", appId: 1001 }],
    logApp: { appId: 1002, profile: "", guestSpaceId: 0, viewId: 0, panelLog: false, panelLogOpen: false, panelLogCount: 20, panelLogRefreshMin: 10, ...logAppOver },
    actions: [{ code: "ev", name: "イベント", type: "record", placements: ["event_edit"], eventLog }],
  });

  const d = diffConfigs(env("failed"), env("all", { appId: 1003 }));
  assert.match(d, /eventLog: failed → all/, d);
  assert.match(d, /ログアプリ \/ appId: 1002 → 1003/, d);

  // 無しとの出入りは今までどおり
  const gone = diffConfigs(env("failed"), { ...env("failed"), logApp: undefined });
  assert.match(gone, /ログアプリ: あり → 無し/, gone);
});

// 2026-11-07 の再判断: 生のファイルの上限 512 KB が、**kintone が受け付ける設定を断っていた**。
// kintone の壁は「圧縮後 256 KB」（公式の setConfig の制限事項）で、生のバイト数は代用にならない。
// スキーマ上限いっぱい（SQL 約 20,000 字 × 50）でも、繰り返しの多い日本語なら圧縮後は壁に収まる
test("saveConfig: kintone が受け付ける大きさの設定を、生のバイト数で断らない", { skip }, async () => {
  const head = "-- @ksql dialect: 1\nDECLARE @cust = '';\n";
  const line = "-- 顧客ごとの売上を集計して集計アプリへ書き戻す。請求対象が「対象」のものだけを数える。\n";
  const sql = head + line.repeat(Math.floor((19900 - head.length) / line.length))
    + "UPDATE LAPP_受注 SET 処理状況 = '済' WHERE 顧客コード = @cust;";
  const config = {
    bindings: [{ name: "受注", appId: 1001 }],
    actions: Array.from({ length: 50 }, (_, n) => ({
      code: `a${n}`, name: `A${n}`, type: "record", placements: ["detail_menu"],
      params: [{ name: "cust", source: "formula", formula: "顧客コード" }],
      sql, confirm: true, writeLimit: 5,
    })),
  };
  const text = JSON.stringify(config);
  assert.ok(Buffer.byteLength(text, "utf8") > 512 * 1024, "前の上限（512 KB）は超えている");

  const r = await save.saveConfig({ file: "settings/kact-big-ok.json", appId: 1001, appName: "受注", config }, opt);
  assert.notEqual(r.status, "invalid", JSON.stringify(r.findings?.map((f) => f.code)));
  assert.equal(r.findings.filter((f) => f.code === "too-large" || f.code === "config-too-large").length, 0,
    JSON.stringify(r.findings));
  assert.equal(existsSync(join(ws, "settings/kact-big-ok.json")), true, "書けている");
});

/**
 * 共通設定を直す（`kact_update_common`）。2026-11-07 の試用 S17 で足した。
 *
 * **なぜ別の口が要るか**: `panel` を書けるのは `kact_save_config` だけだったが、そちらは
 * **共通の文がある設定を丸ごと断る**（`messages-not-writable`）。止めたかったのは
 * 「AI が思いつきで作った文が利用者の文を全置換で潰す」ことなのに、**文を変えずに運ぶだけの保存まで
 * 止めていた**ので、共通の文を使っている設定では `panel` / `limits` / `logApp` / `timezone` が
 * **ツールから一切直せなかった**。ここは `messages` を読みも書きもしない。
 */
test("updateCommon: panel を直す（アクションと messages には触らない）", { skip }, async () => {
  // 共通の文がある設定を作る（ツールからは作れないので、ファイルを直接書く）
  const withMessages = {
    date: "2026-11-07 00:00", pluginName: "kSQL アクション", pluginID: "rex0220 ksql action", PluginVersion: "1",
    appId: 1001, appName: "受注",
    configVersion: 1,
    bindings: [{ name: "受注", appId: 1001 }],
    messages: [{ code: "m_done", text: "終わりました" }],
    limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
    timezone: "",
    panel: { title: "", sectionColumns: 1, buttonWidth: 200, buttonLogLink: false, sections: [], views: [{ viewId: "*", sections: [""], menus: [], open: false }] },
    actions: [{
      enabled: true, code: "sum", name: "集計する", description: "", type: "record", placements: ["detail_menu"],
      panelSection: "", showCond: "", execCond: "", execNgMessage: "", params: [], inputs: [],
      sql: "-- @ksql dialect: 1\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE $id = 1;",
      staticInsertRows: 0, confirm: true, writeLimit: 10, allowed: [], allowAll: true, resultMessage: "$m_done",
      listOnError: "continue", groupFormula: "", perRecordLock: false, prevRecord: false,
    }],
  };
  writeFileSync(join(ws, "settings/with-messages.json"), JSON.stringify(withMessages));
  const digest = save.digestOf(readFileSync(join(ws, "settings/with-messages.json"), "utf8"));

  // まず、この設定は kact_save_config では書けない（止めたままであることも守る）
  const blocked = await save.saveConfig({ file: "settings/blocked.json", appId: 1001, config: withMessages }, opt);
  assert.equal(blocked.status, "invalid");
  assert.equal(blocked.findings[0].code, "messages-not-writable");

  // updateCommon なら直せる（新しい一覧の行を足す）
  const nextPanel = {
    ...withMessages.panel,
    views: [{ viewId: "16551628", sections: [""], menus: [], open: true }],
  };
  const r = await save.updateCommon({ file: "settings/with-messages.json", expectedDigest: digest, common: { panel: nextPanel } }, opt);
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.notEqual(r.digest, digest);
  assert.match(r.changes ?? "", /panel/);

  const env = JSON.parse(readFileSync(join(ws, "settings/with-messages.json"), "utf8"));
  assert.equal(env.panel.views.length, 1);
  assert.equal(env.panel.views[0].viewId, "16551628");
  // アクションと共通の文は無傷
  assert.equal(env.actions.length, 1);
  assert.equal(env.actions[0].resultMessage, "$m_done");
  assert.deepEqual(env.messages, [{ code: "m_done", text: "終わりました" }]);
});

test("updateCommon: 渡したキーだけ差し替える／直せないキーは invalid", { skip }, async () => {
  const digest = save.digestOf(readFileSync(join(ws, "settings/with-messages.json"), "utf8"));
  const r = await save.updateCommon({ file: "settings/with-messages.json", expectedDigest: digest, common: { timezone: "Asia/Tokyo" } }, opt);
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  const env = JSON.parse(readFileSync(join(ws, "settings/with-messages.json"), "utf8"));
  assert.equal(env.timezone, "Asia/Tokyo");
  // 渡していない panel は残る
  assert.equal(env.panel.views[0].viewId, "16551628");

  // actions / messages はこの口では直せない（messages を回り道で書かせない）
  for (const key of ["actions", "messages"]) {
    const ng = await save.updateCommon({ file: "settings/with-messages.json", expectedDigest: r.digest, common: { [key]: [] } }, opt);
    assert.equal(ng.status, "invalid", key);
    assert.match(ng.findings[0].message, /直せないキー/);
  }
  // 空も invalid
  const empty = await save.updateCommon({ file: "settings/with-messages.json", expectedDigest: r.digest, common: {} }, opt);
  assert.equal(empty.status, "invalid");
});

test("updateCommon: digest が違えば conflict（書かない）／検査を通らなければ書かない", { skip }, async () => {
  const before = readFileSync(join(ws, "settings/with-messages.json"), "utf8");
  const conflict = await save.updateCommon({ file: "settings/with-messages.json", expectedDigest: "0".repeat(64), common: { timezone: "UTC" } }, opt);
  assert.equal(conflict.status, "conflict");
  assert.equal(readFileSync(join(ws, "settings/with-messages.json"), "utf8"), before);

  // 形が通らない共通設定は書かない（時間帯の誤り）
  const digest = save.digestOf(before);
  const bad = await save.updateCommon({ file: "settings/with-messages.json", expectedDigest: digest, common: { limits: { readMax: -1 } } }, opt);
  assert.notEqual(bad.status, "ok");
  assert.equal(readFileSync(join(ws, "settings/with-messages.json"), "utf8"), before);
});

test("listActions: 共通設定（panel を含む）を返す", { skip }, async () => {
  const core = await import(pathToFileURL("dist/core.test-bundle.mjs").href);
  const text = readFileSync(join(ws, "settings/with-messages.json"), "utf8");
  const r = await core.listActions(text, opt);
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.ok(r.common, "common が無い（panel が読めないと直しようがない）");
  assert.equal(r.common.panel.views[0].viewId, "16551628");
  assert.equal(r.common.timezone, "Asia/Tokyo");
  assert.deepEqual(r.common.bindings, [{ name: "受注", appId: 1001 }]);
  assert.equal(r.common.logApp, null);
  // 文そのものは返さない（コードだけ）
  assert.deepEqual(r.messages, ["m_done"]);
});

