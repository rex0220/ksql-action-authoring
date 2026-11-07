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

// 2026-11-06 の試用 S3: 定義に無い区分を指定したアクションが警告なしで保存できた。
// 一覧は定義済みの区分としか突き合わせないので、どの一覧にも出ない（静かに消える）
test("checkConfig: 定義に無い区分は警告（保存は止めない）", { skip }, async () => {
  const withPanel = (sections, over) => ({
    configVersion: 1, bindings: [{ name: "受注", appId: 1001 }],
    limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
    timezone: "",
    panel: {
      title: "", sectionColumns: 1, buttonWidth: 200, buttonLogLink: false,
      sections, views: [{ viewId: "*", sections: ["注文"], menus: [], open: false }],
    },
    actions: [{
      enabled: true, code: "mark", name: "印を付ける", description: "", type: "record", onList: true,
      placements: [], panelSection: "保守", showCond: "", execCond: "", execNgMessage: "",
      params: [], inputs: [], sql: "-- @ksql dialect: 1\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 処理状況 = '';",
      staticInsertRows: 0, confirm: true, writeLimit: 10, refreshPrompt: "auto", allowed: [], allowAll: true,
      resultMessage: "", listOnError: "continue", selectionMode: "once", groupFormula: "", perRecordLock: false, prevRecord: false,
      ...over,
    }],
  });
  const def = (name) => ({ enabled: true, name, color: "blue", tone: "soft", collapsed: false });

  const r = await core.checkConfig(envelope(withPanel([def("注文")])), { pluginZip: ZIP });
  assert.equal(r.status, "ok", "警告なので保存は止めない");
  const w = r.findings.find((f) => f.code === "wUnknownSection");
  assert.ok(w, JSON.stringify(r.findings));
  assert.equal(w.level, "warning");
  assert.equal(w.actionCode, "mark");
  assert.match(w.message, /保守/);
  assert.match(w.message, /どこにも出ません/, "detail_menu も無いときは「どこにも出ない」と言う");

  // 定義してあれば出さない
  const ok = await core.checkConfig(envelope(withPanel([def("注文"), def("保守")])), { pluginZip: ZIP });
  assert.equal(ok.findings.filter((f) => f.code === "wUnknownSection").length, 0, JSON.stringify(ok.findings));

  // 無効の区分は「定義していないのと同じ」
  const offSection = await core.checkConfig(envelope(withPanel([def("注文"), { ...def("保守"), enabled: false }])), { pluginZip: ZIP });
  assert.ok(offSection.findings.some((f) => f.code === "wUnknownSection"), JSON.stringify(offSection.findings));

  // 詳細画面には出るので、そう言う
  const onDetail = await core.checkConfig(envelope(withPanel([def("注文")], { placements: ["detail_menu"] })), { pluginZip: ZIP });
  const w2 = onDetail.findings.find((f) => f.code === "wUnknownSection");
  assert.ok(w2, JSON.stringify(onDetail.findings));
  assert.match(w2.message, /詳細画面にはボタンとして出ます/);
});

// 2026-11-06 の試用 S4: 区分なしのアクションを `views[].sections` に載せ忘れると、
// どこにも出ないのに警告が無かった（`wUnknownSection` は「定義に無い区分」だけを見る）。
// `sections: []` は「この一覧には何も出さない」で、「ぜんぶ出す」ではない
test("checkConfig: 一覧のどの行にも載っていないアクションは警告（保存は止めない）", { skip }, async () => {
  const build = (panel, over) => envelope({
    configVersion: 1, bindings: [{ name: "受注", appId: 1001 }],
    limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
    timezone: "",
    ...(panel === undefined ? {} : { panel }),
    actions: [{
      enabled: true, code: "rebuild", name: "作り直す", description: "", type: "app", onList: false,
      placements: [], panelSection: "", showCond: "", execCond: "", execNgMessage: "",
      params: [], inputs: [], sql: "-- @ksql dialect: 1\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 処理状況 = '';",
      staticInsertRows: 0, confirm: true, writeLimit: 10, refreshPrompt: "auto", allowed: [], allowAll: true,
      resultMessage: "", listOnError: "continue", selectionMode: "once", groupFormula: "", perRecordLock: false, prevRecord: false,
      ...over,
    }],
  });
  const panelOf = (views) => ({ title: "", sectionColumns: 1, buttonWidth: 200, buttonLogLink: false, sections: [], views });
  const row = (over) => ({ viewId: "*", sections: [], menus: [], open: false, ...over });

  // 区分なしなのに sections が空 → どこにも出ない
  const empty = await core.checkConfig(build(panelOf([row({})])), { pluginZip: ZIP });
  assert.equal(empty.status, "ok", "警告なので保存は止めない");
  const w = empty.findings.find((f) => f.code === "wNowhereShown");
  assert.ok(w, JSON.stringify(empty.findings));
  assert.equal(w.level, "warning");
  assert.equal(w.actionCode, "rebuild");
  assert.match(w.message, /どこにも出ません/);

  // `sections: [""]` なら出る（既定と同じ形）
  const shown = await core.checkConfig(build(panelOf([row({ sections: [""] })])), { pluginZip: ZIP });
  assert.equal(shown.findings.filter((f) => f.code === "wNowhereShown").length, 0, JSON.stringify(shown.findings));

  // **`panel` を省いても既定にはならない。** `migrateConfig` は `panel.views` を
  // 旧い起動口（`index_panel` / `index_menu`）から起こすので、今の形のアクション
  // （`type: "app"` ＋ `placements: []`）では `sections: []` の行になり、どこにも出ない。
  // `defaultPanel()` の `sections: [""]` が当たるのは、設定を新規に作る経路だけ
  const omitted = await core.checkConfig(build(undefined), { pluginZip: ZIP });
  assert.ok(omitted.findings.some((f) => f.code === "wNowhereShown"), JSON.stringify(omitted.findings));

  // 名前付きの区分だけ並べた行では、区分なしのアクションは出ない
  const named = await core.checkConfig(build(panelOf([row({ sections: ["受注"] })])), { pluginZip: ZIP });
  assert.ok(named.findings.some((f) => f.code === "wNowhereShown"), JSON.stringify(named.findings));

  // 詳細画面のボタンがあるものには出さない（出る口がある）
  const onDetail = await core.checkConfig(
    build(panelOf([row({})]), { type: "record", onList: true, placements: ["detail_menu"] }),
    { pluginZip: ZIP },
  );
  assert.equal(onDetail.findings.filter((f) => f.code === "wNowhereShown").length, 0, JSON.stringify(onDetail.findings));

  // 詳細画面の行（viewId: "detail"）の menus は一覧に出す指定ではない
  const detailRow = await core.checkConfig(
    build(panelOf([row({ viewId: "detail", menus: [""] }), row({})])),
    { pluginZip: ZIP },
  );
  assert.ok(detailRow.findings.some((f) => f.code === "wNowhereShown"), JSON.stringify(detailRow.findings));
});

// 2026-11-06 の試用 S1: 推奨の標準形（キーの配列）がいつも FULL_SCAN・constant false に見え、
// 「条件が効かず全件に当たる」を見つけるための計画が、その判定に使えなかった
test("arrayDeclareNames: 配列で宣言した変数を拾う（コメントは見ない）", () => {
  assert.deepEqual(core.arrayDeclareNames("-- @ksql dialect: 1\nDECLARE @keys = [];\nDECLARE @now = '';\n"), ["keys"]);
  assert.deepEqual(core.arrayDeclareNames("DECLARE @_selected = [];\nDECLARE @a = [1, 2];\n"), ["_selected", "a"]);
  assert.deepEqual(core.arrayDeclareNames("-- DECLARE @keys = [];\nDECLARE @cust = '';\n"), [], "コメントの中を拾っている");
  assert.deepEqual(core.arrayDeclareNames("declare @Keys = [ ];\n"), ["Keys"], "大文字小文字を無視していない");
});

test("explainAction: 配列の変数があれば constant false の読み方を注記する", { skip }, async () => {
  const props = (names) =>
    Object.fromEntries(names.map((n) => [n, { type: n === "金額" || n === "件数" ? "NUMBER" : "SINGLE_LINE_TEXT", code: n, label: n }]));
  const config = {
    configVersion: 1,
    bindings: [{ name: "受注", appId: 4377 }, { name: "集計", appId: 4378 }],
    limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
    timezone: "",
    actions: [{
      enabled: true, code: "upd", name: "キーの配列で更新", description: "", type: "record", onList: false,
      placements: ["event_edit"], panelSection: "", showCond: "", execCond: "", execNgMessage: "",
      params: [{ name: "keys", source: "keys", formula: "顧客コード" }], inputs: [],
      sql: "-- @ksql dialect: 1\nDECLARE @keys = [];\nUPDATE LAPP_集計 SET 件数 = 0 WHERE 顧客コード IN @keys;",
      staticInsertRows: 0, confirm: false, writeLimit: 10, refreshPrompt: "auto", allowed: [], allowAll: true,
      resultMessage: "", listOnError: "continue", selectionMode: "loop", groupFormula: "", perRecordLock: false, prevRecord: false,
    }],
  };
  const fields = { "4377": props(["顧客コード", "金額"]), "4378": props(["顧客コード", "件数"]) };
  const r = await core.explainAction(envelope(config), { action: "upd" }, { pluginZip: ZIP, fields });
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  const note = r.findings.find((f) => f.code === "explain-array-empty");
  assert.ok(note, JSON.stringify(r.findings));
  assert.equal(note.level, "info", "保存を止める話ではない");
  assert.match(note.message, /@keys/);
  assert.match(note.message, /条件が効いていないという意味ではない/);
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
    // 版 9 からは本体の `sqlProblemText` が作る文（設定画面と同じ）。行番号は文の中に入る
    assert.match(errors[0].message, /^SQL の構文エラー: \d+ 行目: /, errors[0].message);
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
  const broken = 'この顧客を集計しました（書き込み " & $result_total & " 件）';
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
    resultMessage: '"書き込み " & $result_total & " 件"',
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

/**
 * `source: "keys"` の式も検査する（2026-11-06）。本体の `paramRule` は `formula` と `keys` の**両方**を見るので、
 * tools が `keys` を飛ばすと、壊れた式のまま `kact_save_config` で書けてしまい、
 * **利用者が取り込んだ設定画面の保存で初めて止まる**（理由が分からない）。
 */
test("checkConfig: source: keys の式も構文を見る", { skip }, async () => {
  const sql = "-- @ksql dialect: 1\nDECLARE @keys = [];\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 顧客コード IN @keys;";
  const broken = 'IF(顧客コード <> "", "A"'; // 閉じ括弧が無い
  const r = await core.checkConfig(envelope(formulaAction({
    params: [{ name: "keys", source: "keys", formula: broken }], sql,
  })), { pluginZip: ZIP });
  assert.equal(r.status, "invalid", JSON.stringify(r.findings));
  assert.ok(r.findings.some((f) => f.code === "pFormulaSyntax" && /keys/.test(f.message)), JSON.stringify(r.findings));

  // 正しい式なら通る（検査を足したことで素の設定が落ちないこと）
  const ok = await core.checkConfig(envelope(formulaAction({
    params: [{ name: "keys", source: "keys", formula: "顧客コード" }], sql,
  })), { pluginZip: ZIP });
  assert.equal(ok.status, "ok", JSON.stringify(ok.findings));
});

/**
 * 無効の行（`enabled: false`）は式を検査しない（2026-11-06）。
 * 本体は `dialogs.ts` の `structuralProblems` と `paramRule` で外しているので、tools だけが拒むと
 * **設定画面では保存できる設定が `kact_save_config` で書けない**。「一時的に無効」は作りかけの式を
 * 置いたままにするための機能（2026-11-05 Takashi）なので、そこを拒むと機能の意味が無くなる。
 */
test("checkConfig: 無効のパラメーター・入力項目の式は検査しない", { skip }, async () => {
  const broken = 'IF(顧客コード <> "", "A"'; // 閉じ括弧が無い
  const bad = await core.checkConfig(envelope(formulaAction({
    params: [{ name: "cust", source: "formula", formula: broken }],
  })), { pluginZip: ZIP });
  assert.equal(bad.status, "invalid", "有効な行の壊れた式は誤りのまま");

  const offParam = await core.checkConfig(envelope(formulaAction({
    params: [{ name: "cust", source: "formula", formula: broken, enabled: false }],
  })), { pluginZip: ZIP });
  assert.equal(offParam.status, "ok", JSON.stringify(offParam.findings));

  const offInput = await core.checkConfig(envelope(formulaAction({
    inputs: [{ name: "memo", label: "メモ", type: "text", required: false, defaultFormula: broken, options: [], enabled: false }],
  })), { pluginZip: ZIP });
  assert.equal(offInput.status, "ok", JSON.stringify(offInput.findings));
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
    resultMessage: '"書き込み " & $result_total & " 件"',
  })), { pluginZip: ZIP });
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.equal(r.findings.length, 0, JSON.stringify(r.findings));
});

// 2026-11-07 の試用 S5: 一覧の渡し方が「1 件ずつ」のままテーブルを全置換する APPLY を
// 書くと、同じ親のレコードを 2 件以上選んだときに最後の 1 件ぶんしか残らない。
// 資料は「『1 件ずつ』では成立しません」と書いているのに、検査は何も言わなかった。
// しかも selectionMode の既定が "loop" なので、書き忘れただけでこの形になる
test("checkConfig: 一覧の「1 件ずつ」＋ テーブルの全置換は警告（保存は止めない）", { skip }, async () => {
  const applySql = "-- @ksql dialect: 1\nDECLARE @cust = '';\n"
    + "UPDATE LAPP_集計 SET 集計日時 = @NOW()\n WHERE 顧客コード = @cust\n APPLY 明細 (\n"
    + "   REMOVE ALL ROWS;\n   APPEND (担当者) SELECT 担当者 FROM LAPP_受注 WHERE 顧客コード = @cust GROUP BY 担当者\n );";
  const build = (over) => envelope({
    configVersion: 1, bindings: [{ name: "受注", appId: 1001 }, { name: "集計", appId: 1002 }],
    limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
    timezone: "",
    panel: { title: "", sectionColumns: 1, buttonWidth: 200, buttonLogLink: false, sections: [], views: [{ viewId: "*", sections: [""], menus: [], open: false }] },
    actions: [{
      enabled: true, code: "appl", name: "明細へ", description: "", type: "record", onList: true,
      placements: [], panelSection: "", showCond: "", execCond: "", execNgMessage: "",
      params: [{ name: "cust", source: "formula", formula: "顧客コード" }], inputs: [], sql: applySql,
      staticInsertRows: 0, confirm: true, writeLimit: 10, refreshPrompt: "auto", allowed: [], allowAll: true,
      resultMessage: "", listOnError: "continue", groupFormula: "", perRecordLock: false, prevRecord: false,
      ...over,
    }],
  });

  // selectionMode を書いていない（既定の「1 件ずつ」）→ 警告
  const def = await core.checkConfig(build({}), { pluginZip: ZIP });
  assert.equal(def.status, "ok", "警告なので保存は止めない");
  const w = def.findings.find((f) => f.code === "wListApplyLoop");
  assert.ok(w, JSON.stringify(def.findings));
  assert.equal(w.actionCode, "appl");
  assert.match(w.message, /最後の 1 件ぶんしか残りません/);

  // はっきり "loop" と書いても同じ
  const loop = await core.checkConfig(build({ selectionMode: "loop" }), { pluginZip: ZIP });
  assert.ok(loop.findings.some((f) => f.code === "wListApplyLoop"), JSON.stringify(loop.findings));

  // 「グループごと」「まとめて 1 回」なら出さない
  for (const mode of ["group", "once"]) {
    const r = await core.checkConfig(build({ selectionMode: mode, groupFormula: mode === "group" ? "顧客コード" : "" }), { pluginZip: ZIP });
    assert.equal(r.findings.filter((f) => f.code === "wListApplyLoop").length, 0, `${mode}: ${JSON.stringify(r.findings)}`);
  }

  // 詳細画面のボタン（一覧で使わない）は 1 件 = 1 つの親なので出さない
  const detail = await core.checkConfig(build({ onList: false, placements: ["detail_menu"] }), { pluginZip: ZIP });
  assert.equal(detail.findings.filter((f) => f.code === "wListApplyLoop").length, 0, JSON.stringify(detail.findings));

  // APPLY が無ければ出さない
  const noApply = await core.checkConfig(build({ sql: "-- @ksql dialect: 1\nDECLARE @cust = '';\nUPDATE LAPP_集計 SET 集計日時 = @NOW() WHERE 顧客コード = @cust;" }), { pluginZip: ZIP });
  assert.equal(noApply.findings.filter((f) => f.code === "wListApplyLoop").length, 0, JSON.stringify(noApply.findings));

  // コメントの中の APPLY は拾わない
  const commented = await core.checkConfig(build({ sql: "-- @ksql dialect: 1\n-- APPLY 明細 ( REMOVE ALL ROWS; )\nDECLARE @cust = '';\nUPDATE LAPP_集計 SET 集計日時 = @NOW() WHERE 顧客コード = @cust;" }), { pluginZip: ZIP });
  assert.equal(commented.findings.filter((f) => f.code === "wListApplyLoop").length, 0, JSON.stringify(commented.findings));
});

/**
 * 版 9（2026-11-07）: 検査の文が**設定画面と同じ文**になる。
 * それまでは `detail` と `kind` を素で並べるしかなく、`pInputTypeMismatch` が
 * **`"min / text"`** という読めない findings になっていた（試用 S4 の指摘）。
 * 文言は本体（zip）の `sqlProblemText` が作るので、**tools 側に写していないこと**も
 * ここで守る（写すと本体の文と食い違う）。
 */
test("checkConfig: 問題の文は本体の文言で出す（版 9。コードと値を素で並べない）", { skip }, async () => {
  const config = {
    configVersion: 1,
    limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
    timezone: "",
    bindings: [{ name: "受注", appId: 4377 }],
    actions: [{
      enabled: true, code: "mismatch", name: "型の食い違い", description: "", type: "record", placements: ["detail_menu"],
      targetViews: [], showCond: "", execCond: "", execNgMessage: "",
      // 数値で宣言した変数に「文字列」の入力項目を当てる → pInputTypeMismatch
      params: [{ name: "min", source: "input", formula: "", enabled: true }],
      inputs: [{ enabled: true, name: "min", label: "下限", type: "text", required: false, defaultFormula: "", options: [] }],
      sql: "-- @ksql dialect: 1\nDECLARE @min = 0;\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 金額 >= @min;",
      staticInsertRows: 0, confirm: true, writeLimit: 0, allowed: [], resultMessage: "",
      listOnError: "continue", selectionMode: "loop", groupFormula: "", perRecordLock: false, prevRecord: false,
    }],
  };
  const r = await core.checkConfig(envelope(config), { pluginZip: ZIP });
  const found = r.findings.filter((f) => f.code === "pInputTypeMismatch");
  assert.equal(found.length, 1, JSON.stringify(r.findings));
  const message = found[0].message;
  // 素の並び（"min / text"）に戻っていないこと
  assert.notEqual(message, "min / text", "detail と kind を素で並べている（版 9 の文を使っていない）");
  assert.match(message, /@min/, message);
  // 入力項目の種類は画面と同じ名前（コードの "text" ではなく「文字列」）
  assert.match(message, /文字列/, message);
  assert.ok(message.length > 20, `文が短すぎる: ${message}`);
  if (process.env.KACT_SHOW_MESSAGE) console.log(`    [版 9 の文] ${message}`);
});

// 2026-11-07 の試用 S6: 結果の変数は API 版 6 で `_result_*` → `$result_*` に変わったが、
// migrateConfig に書き換えが無いので版 6 より前の設定はそのまま残る。
// そのとき出るのは「`_result_total` という項目も関数も無い」だけで、**改名が分からない**
test("checkConfig: 古い `_result_*` には改名を案内する", { skip }, async () => {
  const build = (formula) => envelope({
    configVersion: 1, bindings: [{ name: "受注", appId: 1001 }],
    limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
    timezone: "",
    panel: { title: "", sectionColumns: 1, buttonWidth: 200, buttonLogLink: false, sections: [], views: [{ viewId: "*", sections: [""], menus: [], open: false }] },
    actions: [{
      enabled: true, code: "old", name: "古い結果メッセージ", description: "", type: "record", onList: false,
      placements: ["detail_menu"], panelSection: "", showCond: "", execCond: "", execNgMessage: "",
      params: [], inputs: [], sql: "-- @ksql dialect: 1\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 処理状況 = '';",
      staticInsertRows: 0, confirm: true, writeLimit: 1, refreshPrompt: "auto", allowed: [], allowAll: true,
      resultMessage: formula, listOnError: "continue", selectionMode: "loop", groupFormula: "",
      loop: "", loopOnError: "stop", perRecordLock: false, prevRecord: false,
    }],
  });
  // 項目定義の控えが要る（無いと構文だけ見るので「項目が無い」にならない）
  const fields = { 処理状況: { type: "SINGLE_LINE_TEXT", code: "処理状況", label: "処理状況" } };
  const opt = { pluginZip: ZIP, fields, appId: 1001 };

  const old = await core.checkConfig(build('"済みました（" & _result_total & " 件）"'), opt);
  const f = old.findings.find((x) => x.code === "pFormulaField");
  assert.ok(f, JSON.stringify(old.findings));
  assert.match(f.message, /\$result_\*/, "改名の案内を添える");
  assert.match(f.message, /\$result_total/, "直した形を見せる");
  assert.match(f.message, /版 6/);

  // 新しい名前なら誤りにしない
  const now = await core.checkConfig(build('"済みました（" & $result_total & " 件）"'), opt);
  assert.equal(now.findings.filter((x) => x.code === "pFormulaField").length, 0, JSON.stringify(now.findings));
});

// 2026-11-07 の試用 S10: 共通の文（messages。API 版 7）を使う設定が 1 つも保存できなかった。
// `contextsFrom` が `loadFormulaContext` に messages を渡しておらず、`$m_…` の擬似項目が
// 1 つも無い状態で式を検査していたため、**正しく定義したコードまで**「無い項目」で止まった。
// 本体の設定画面は 2026-11-06 に同じ穴を setMessages で直している（screen.ts の注記）
test("checkConfig: 共通の文（$m_…）は messages に定義してあれば通る", { skip }, async () => {
  const build = (messages) => envelope({
    configVersion: 1, bindings: [{ name: "受注", appId: 1001 }],
    limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
    timezone: "",
    ...(messages ? { messages } : {}),
    panel: { title: "", sectionColumns: 1, buttonWidth: 200, buttonLogLink: false, sections: [], views: [{ viewId: "*", sections: [""], menus: [], open: false }] },
    actions: [{
      enabled: true, code: "msg", name: "共通の文を使う", description: "", type: "record", onList: false,
      placements: ["detail_menu"], panelSection: "", showCond: "", execCond: "金額 <> \"\"",
      execNgMessage: "$m_no_amount",
      resultMessage: "REPLACE($m_done, \"{n}\", $result_total)",
      params: [], inputs: [], sql: "-- @ksql dialect: 1\nDECLARE @_record = 0;\nUPDATE LAPP_受注 SET 処理メモ = 'x' WHERE $id = @_record;",
      staticInsertRows: 0, confirm: true, writeLimit: 1, refreshPrompt: "auto", allowed: [], allowAll: true,
      listOnError: "continue", selectionMode: "loop", groupFormula: "", loop: "", loopOnError: "stop",
      perRecordLock: false, prevRecord: false,
    }],
  });
  const fields = {
    金額: { type: "NUMBER", code: "金額", label: "金額" },
    処理メモ: { type: "SINGLE_LINE_TEXT", code: "処理メモ", label: "処理メモ" },
  };
  const opt = { pluginZip: ZIP, fields, appId: 1001 };
  const messages = [
    { code: "m_no_amount", text: "金額が空です" },
    { code: "m_done", text: "{n} 件を書き込みました" },
  ];

  // 定義してあれば通る（ここが落ちていた）
  const ok = await core.checkConfig(build(messages), opt);
  assert.equal(ok.status, "ok", JSON.stringify(ok.findings));
  assert.equal(ok.findings.filter((f) => f.code === "pFormulaField").length, 0, JSON.stringify(ok.findings));

  // 定義が無ければ今までどおり止まる（守りは残す）
  const ng = await core.checkConfig(build(undefined), opt);
  assert.equal(ng.status, "invalid");
  assert.ok(ng.findings.some((f) => String(f.message).includes("message:unknown")), JSON.stringify(ng.findings));
  // 「項目も関数も無い」だけだと打ち間違いに見えるので、共通の文の話だと添える
  const hint = ng.findings.find((f) => f.code === "pFormulaField");
  assert.ok(hint, JSON.stringify(ng.findings));
  assert.match(hint.message, /\u5171\u901a\u306e\u6587/);
  assert.match(hint.message, /execNgMessage/);
});

// 2026-11-07 の対応漏れの洗い出し: 結果メッセージの文脈に**ループかどうか**を渡していなかった。
// `$result_runs` ほか 4 つは本体の RESULT_LOOP_FIELDS で「ループのときだけ」足されるので、
// 渡さないと**設定画面は通すのに tools だけが「無い項目」で拒む**
test("checkConfig: ループの結果メッセージは $result_runs を使える", { skip }, async () => {
  const build = (loop, resultMessage) => envelope({
    configVersion: 1, bindings: [{ name: "受注", appId: 1001 }],
    limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
    timezone: "",
    panel: { title: "", sectionColumns: 1, buttonWidth: 200, buttonLogLink: false, sections: [], views: [{ viewId: "*", sections: [""], menus: [], open: false }] },
    actions: [{
      enabled: true, code: "lp", name: "ループ", description: "", type: "app", onList: false,
      placements: [], panelSection: "", showCond: "", execCond: "", execNgMessage: "",
      params: [], inputs: [], resultMessage,
      sql: "-- @ksql dialect: 1\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 処理状況 = '';",
      staticInsertRows: 0, confirm: true, writeLimit: 10, refreshPrompt: "auto", allowed: [], allowAll: true,
      listOnError: "continue", selectionMode: "loop", groupFormula: "", loop, loopOnError: "stop",
      perRecordLock: false, prevRecord: false,
    }],
  });
  const fields = { 処理状況: { type: "SINGLE_LINE_TEXT", code: "処理状況", label: "処理状況" } };
  const opt = { pluginZip: ZIP, fields, appId: 1001 };
  const msg = '"回数 " & $result_runs & " / 成功 " & $result_ok_runs';

  // ループあり → 使える（ここが落ちていた）
  const looped = await core.checkConfig(build("3", msg), opt);
  assert.equal(looped.findings.filter((f) => f.code === "pFormulaField").length, 0, JSON.stringify(looped.findings));

  // ループなし → これまでどおり「無い項目」（ループ専用の擬似項目なので、足してはいけない）
  const plain = await core.checkConfig(build("", msg), opt);
  assert.ok(plain.findings.some((f) => f.code === "pFormulaField"), JSON.stringify(plain.findings));

  // ループでなくても、ふつうの $result_* は使える
  const normal = await core.checkConfig(build("", '"合計 " & $result_total'), opt);
  assert.equal(normal.findings.filter((f) => f.code === "pFormulaField").length, 0, JSON.stringify(normal.findings));
});

// 2026-11-07 の対応漏れの洗い出し: 設定画面が見ない口を tools が見ていた。
// 本体は groupFormula を「グループごと」のときだけ、loop を hasLoop のときだけ検査する。
// 条件なしで見ると、渡し方を変えた後の残りかすが **tools だけで** 保存を止める
// （S6 のとおり、エラーが 1 つあると kact_update_action は何も書けない）
test("checkConfig: 効かない式（残りかす）は設定画面と同じく見ない", { skip }, async () => {
  const build = (over) => envelope({
    configVersion: 1, bindings: [{ name: "受注", appId: 1001 }],
    limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
    timezone: "",
    panel: { title: "", sectionColumns: 1, buttonWidth: 200, buttonLogLink: false, sections: [], views: [{ viewId: "*", sections: [""], menus: [], open: false }] },
    actions: [{
      enabled: true, code: "left", name: "残りかす", description: "", type: "record", onList: true,
      placements: ["detail_menu"], panelSection: "", showCond: "", execCond: "", execNgMessage: "",
      params: [], inputs: [], resultMessage: "",
      sql: "-- @ksql dialect: 1\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 処理状況 = '';",
      staticInsertRows: 0, confirm: true, writeLimit: 10, refreshPrompt: "auto", allowed: [], allowAll: true,
      listOnError: "continue", selectionMode: "loop", groupFormula: "", loop: "", loopOnError: "stop",
      perRecordLock: false, prevRecord: false,
      ...over,
    }],
  });
  const fields = { 処理状況: { type: "SINGLE_LINE_TEXT", code: "処理状況", label: "処理状況" } };
  const opt = { pluginZip: ZIP, fields, appId: 1001 };

  // 「1 件ずつ」に戻したあとに残った分ける式は見ない（設定画面も見ない）
  const leftover = await core.checkConfig(build({ selectionMode: "loop", groupFormula: "もう無い項目" }), opt);
  assert.equal(leftover.findings.filter((f) => f.code === "pFormulaField").length, 0, JSON.stringify(leftover.findings));

  // 「グループごと」なら今までどおり見る
  const grouped = await core.checkConfig(build({ selectionMode: "group", groupFormula: "もう無い項目" }), opt);
  assert.ok(grouped.findings.some((f) => f.code === "pFormulaField"), JSON.stringify(grouped.findings));

  // ループを空にした後に残った式も見ない
  const noLoop = await core.checkConfig(build({ loop: "", resultMessage: "" }), opt);
  assert.equal(noLoop.findings.filter((f) => f.code === "pFormulaField").length, 0, JSON.stringify(noLoop.findings));
});

// 2026-11-07 の対応漏れの洗い出し: 共通の文を書ける 3 つの口（本体の MESSAGE_SLOTS =
// execNgMessage / resultMessage / optionLabelsFormula）が、それぞれ別の文脈で検査される。
// resultMessage だけは result() 側が $m_… を含むので、message() に回すと $result_* を失う。
// この 3 つを一度に固定して、今日の直しが将来ほどけないようにする
test("checkConfig: 共通の文は 3 つの口すべてで使え、ほかの口では使えない", { skip }, async () => {
  const messages = [{ code: "m_x", text: "文" }];
  const build = (over) => envelope({
    configVersion: 1, bindings: [{ name: "受注", appId: 1001 }], messages,
    limits: { readMax: 10000, tempTableMax: 10000, tempTotalMax: 20000, timeoutMin: 60, apiTimeoutSec: 60, listBulkMax: 300, applySubtableMax: 500 },
    timezone: "",
    panel: { title: "", sectionColumns: 1, buttonWidth: 200, buttonLogLink: false, sections: [], views: [{ viewId: "*", sections: [""], menus: [], open: false }] },
    actions: [{
      enabled: true, code: "ms", name: "共通の文", description: "", type: "record", onList: false,
      placements: ["detail_menu"], panelSection: "", showCond: "", execCond: "", execNgMessage: "",
      params: [], inputs: [], resultMessage: "",
      sql: "-- @ksql dialect: 1\nUPDATE LAPP_受注 SET 処理状況 = '済' WHERE 処理状況 = '';",
      staticInsertRows: 0, confirm: true, writeLimit: 1, refreshPrompt: "auto", allowed: [], allowAll: true,
      listOnError: "continue", selectionMode: "loop", groupFormula: "", loop: "", loopOnError: "stop",
      perRecordLock: false, prevRecord: false,
      ...over,
    }],
  });
  const fields = { 処理状況: { type: "SINGLE_LINE_TEXT", code: "処理状況", label: "処理状況" } };
  const opt = { pluginZip: ZIP, fields, appId: 1001 };
  const noField = (r) => r.findings.filter((f) => f.code === "pFormulaField").length;

  // ① 実行条件 NG のメッセージ
  assert.equal(noField(await core.checkConfig(build({ execCond: '処理状況 <> ""', execNgMessage: "$m_x" }), opt)), 0);
  // ② 結果メッセージ（$result_* と混ぜても通ること＝ message() に回していない証拠）
  assert.equal(noField(await core.checkConfig(build({ resultMessage: '$m_x & " " & $result_total' }), opt)), 0);
  // ③ 選択肢のラベル（型が select のときだけ見る口）
  assert.equal(noField(await core.checkConfig(build({
    params: [{ enabled: true, name: "k", source: "input", formula: "" }],
    inputs: [{ enabled: true, name: "k", label: "区分", type: "select", required: false, defaultFormula: "", options: ["a"], optionsFormula: '"a"', optionLabelsFormula: "$m_x", minValue: "", maxValue: "", minLength: "", maxLength: "" }],
    sql: "-- @ksql dialect: 1\nDECLARE @k = '';\nUPDATE LAPP_受注 SET 処理状況 = @k WHERE 処理状況 = '';",
  }), opt)), 0);

  // 書けない口では今までどおり止まる（本体の message:slot と、文脈に無いことの両方）
  const bad = await core.checkConfig(build({ showCond: "$m_x" }), opt);
  assert.equal(bad.status, "invalid");
  assert.ok(bad.findings.some((f) => String(f.message).includes("message:slot")), JSON.stringify(bad.findings));
});
