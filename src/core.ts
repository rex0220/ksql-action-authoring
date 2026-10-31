/**
 * tools の中核（段階 1）。zip のオーサリング API を使って、設定ファイルの診断・検査・一覧を行う。
 * MCP（`kact_status` / `kact_check` / `kact_actions`）と CLI の両方がここを呼ぶ。
 *
 * 約束:
 * - **kintone には通信しない**（この段階は作業フォルダーのファイルと zip だけ）
 * - **設定の中身（SQL 本文・値）はそのまま返さない**。行数・要点・項目コードだけを返す
 * - 返りは `{ status, findings, ... }` の形（status: ok / invalid / incompatible / failed）
 */
import { readFileSync } from "node:fs";
import { loadEngine, type Engine, type LoadEngineOptions } from "./engine.ts";
import { PluginZipError } from "./plugin-zip.ts";
import { toolsMeta } from "./meta.ts";

/** 返りの状態（印刷屋の MCP と同じ語。conflict と denied は段階 2 の保存で使う） */
export type ToolStatus = "ok" | "invalid" | "incompatible" | "conflict" | "denied" | "failed";

export interface Finding {
  /** error = 保存できない / warning = 保存はできる注意 / info = 参考 */
  level: "error" | "warning" | "info";
  /** 規則の名前（プラグインの検査のコード、または tools の判定） */
  code: string;
  message: string;
  /** 何番目のアクションか（1 始まり。設定全体のときは無し） */
  actionIndex?: number;
  actionCode?: string;
}

export interface StatusResult {
  status: ToolStatus;
  tools: ReturnType<typeof toolsMeta>;
  plugin?: {
    /** zip から読んだプラグインの版と API の版 */
    pluginVersion: string;
    apiVersion: number;
    pluginId?: string;
    /** 読み込んだファイルの sha256（zip が差し替わっていないかの照合に使う） */
    sha256: { engine: string; api?: string };
    /** 計算式エンジンが使えるか */
    formulaEngine: boolean;
  };
  /**
   * kintone の接続の診断（段階 3）。**秘密の値は出さない**: 出すのはファイルの名前（パスは出さない）、
   * profile の名前、接続先のホスト、認証の種類、トークンを持つアプリの番号と、それが使える状態か、まで
   */
  connection?: ConnectionReport;
  findings: Finding[];
}

export interface ConnectionReport {
  /** 接続のファイルが設定されているか（`KACT_KINTONE_CONFIG`） */
  configured: boolean;
  /** 読めたファイルの名前（パスは出さない） */
  fileName?: string;
  defaultProfile?: string;
  profiles?: Array<{
    profile: string;
    host: string;
    guestSpaceId: number | null;
    auth: "token" | "userpass";
    /** トークンを持つアプリの番号（値は持たない） */
    tokenApps: number[];
    /** アプリごとに、トークンが使える状態か（env: の変数があるか） */
    tokenReady: Record<number, boolean>;
    userpassReady: boolean;
  }>;
  /** 使えない profile と理由（値は含まない） */
  invalid?: Array<{ name: string; reason: string }>;
}

/** zip と tools の診断（kact_status）。zip の場所と接続のファイルの場所は呼び出し側が決めて渡す */
export async function statusOf(opt: LoadEngineOptions & { connection?: ConnectionReport } = {}): Promise<StatusResult> {
  const tools = toolsMeta();
  const connection = opt.connection ? { connection: opt.connection } : {};
  try {
    const engine = await loadEngine(opt);
    const findings: Finding[] = engine.warnings.map((w) => ({ level: "warning" as const, code: "zip-warning", message: w }));
    return {
      status: "ok",
      tools,
      plugin: {
        pluginVersion: String(engine.api.pluginVersion),
        apiVersion: Number(engine.api.apiVersion),
        ...(engine.source.pluginId ? { pluginId: engine.source.pluginId } : {}),
        sha256: { engine: engine.source.engineSha256, ...(engine.source.apiSha256 ? { api: engine.source.apiSha256 } : {}) },
        formulaEngine: engine.api.formulaEngineLoaded(),
      },
      ...connection,
      findings,
    };
  } catch (e) {
    const info = e instanceof PluginZipError ? e : undefined;
    return {
      status: info && (info.code === "unsupported-version" || info.code === "api-unsupported") ? "incompatible" : "failed",
      tools,
      ...connection,
      findings: [{ level: "error", code: info?.code ?? "engine-load-failed", message: e instanceof Error ? e.message : String(e) }],
    };
  }
}

/**
 * 封筒形式の設定ファイルを読む（pluginID と形を確かめる）。
 * **古い形は直してから検証する**（設定画面の取り込みと同じ順）。API の版 2 からは本体の `parseConfigFile` が
 * その順でやってくれる。版 1 の zip では `parseImport`（検証が先）なので、後から足した項目を持たない
 * 古いファイルは通らないことがある（その場合は新しい zip を使ってもらう）
 */
function parseConfigFile(engine: Engine, text: string): { config: Record<string, unknown>; envelope: Record<string, unknown> } {
  const api = engine.api as typeof engine.api & {
    parseConfigFile?: (text: string) => { data: Record<string, unknown>; envelope: Record<string, unknown> };
  };
  if (typeof api.parseConfigFile === "function") {
    const r = api.parseConfigFile(text);
    return { config: r.data, envelope: r.envelope };
  }
  const parsed = engine.api.parseImport(text, String(engine.api.pluginIdName), engine.api.CONFIG_SCHEMA) as {
    data: Record<string, unknown>;
    envelope: Record<string, unknown>;
  };
  const config = engine.api.migrateConfig(parsed.data) as Record<string, unknown>;
  return { config, envelope: parsed.envelope };
}

export interface CheckResult {
  status: ToolStatus;
  /** 設定の要約（値は含まない） */
  summary?: {
    actions: number;
    enabled: number;
    bindings: string[];
    logApp: boolean;
    /** アクションごとの SQL の行数 */
    sqlLines: number[];
    /** 計算式をどこまで見たか（`fields` = 項目コード・関数名まで、`syntax` = 引用符と括弧の対応だけ） */
    formulaCheck?: "fields" | "syntax";
  };
  findings: Finding[];
}

/** 計算式の口（設定画面の `collectFormulaProblems` と同じ。`where` は利用者に出す名前） */
function formulaSlots(action: Record<string, unknown>): Array<{ where: string; raw: string }> {
  const slots: Array<{ where: string; raw: string }> = [
    { where: "showCond（表示条件）", raw: String(action.showCond ?? "") },
    { where: "execCond（実行条件）", raw: String(action.execCond ?? "") },
    { where: "execNgMessage（実行条件 NG のメッセージ）", raw: String(action.execNgMessage ?? "") },
    { where: "groupFormula（分ける式）", raw: String(action.groupFormula ?? "") },
    { where: "resultMessage（結果メッセージ）", raw: String(action.resultMessage ?? "") },
  ];
  for (const p of (Array.isArray(action.params) ? action.params : []) as Array<Record<string, unknown>>) {
    if (p.source === "formula") slots.push({ where: `params ${String(p.name ?? "")} の式`, raw: String(p.formula ?? "") });
  }
  for (const i of (Array.isArray(action.inputs) ? action.inputs : []) as Array<Record<string, unknown>>) {
    slots.push({ where: `inputs ${String(i.name ?? "")} の既定値`, raw: String(i.defaultFormula ?? "") });
  }
  return slots.filter((s) => s.raw.trim() !== "");
}

/** 項目定義が無い文脈でも分かる誤り（= 構文）だけを拾う。項目名・関数名の誤りは「項目が無い」と同じ形で出るので除く */
const UNKNOWN_NAME = /FIELD CODE NOT FOUND:\s*([\s\S]*)$/;

/**
 * 「項目が無い」と言われた名前に、**項目コードには入らない文字**（空白・引用符・句読点）が混じっていたら、
 * それは項目参照ではなく**引用符を忘れた素の文**。2026-10-28 の試用（S4）で、`execNgMessage` に
 * 引用符の無い文（`顧客コードが空のため…ください。`）が入ったまま検査を通っていた。
 * 括弧・引用符の**対応は取れている**ので構文としては正しく、項目定義が入る段階 3 までは区別できない。
 * **error にはしない**（本物の項目名を弾かないため。保存は止めずに警告で伝える）。
 */
const NOT_A_FIELD_CODE = /[\s"'。、，．！？!?]/;

/** 計算式の文脈（`loadFormulaContext` が作る形。アクションの種類で使い分ける） */
interface FormulaContexts {
  record: { pp: unknown; crec: unknown };
  none: { pp: unknown; crec: unknown };
  result: (base: "record" | "none") => { pp: unknown; crec: unknown };
}

/**
 * 項目定義から計算式の文脈を作る（**本体の `loadFormulaContext` をそのまま使う**。項目の型から検査用のレコードを組む
 * ところを写さないため）。`loadFormulaContext` は `/k/v1/preview/app/form/fields` を 1 回だけ読むので、
 * kintone に行かず控え（`kact_fields` が置いた properties）を返す偽の client を渡す。
 */
async function contextsFrom(engine: Engine, properties: Record<string, unknown>, appId: number): Promise<FormulaContexts> {
  const client = { api: async () => ({ properties }) };
  return (await engine.api.loadFormulaContext(client as never, appId)) as unknown as FormulaContexts;
}

/** 項目定義が無い文脈でも分かる誤り（= 構文）だけを拾う。項目名・関数名の誤りは「項目が無い」と同じ形で出るので除く */
const UNKNOWN_NAME_RE = UNKNOWN_NAME;

/**
 * 計算式を見る。
 * - **項目定義が無いとき（`contexts` なし）は構文だけ**（引用符・括弧の対応）。項目名・関数名は「項目が無い」と
 *   同じ形で返るので区別できない（2026-10-28 の試用 S3 で、引用符が落ちた `resultMessage` が通っていたため足した）
 * - **項目定義があるとき（`kact_fields` の控え）は設定画面の保存と同じ検査**（`collectFormulaProblems` と同じ口・
 *   同じ文脈の使い分け）。項目コードと関数名の誤りもここで止まる
 * **findings に式そのものは入れない**（口の名前だけ出す。設定の中身は返さない約束）。
 */
function checkFormulas(engine: Engine, actions: Array<Record<string, unknown>>, contexts?: FormulaContexts): Finding[] {
  if (!engine.api.formulaEngineLoaded()) {
    return [{ level: "warning", code: "formula-engine-missing", message: "計算式エンジンが読めないので、式は見ていない" }];
  }
  const findings: Finding[] = [];
  const emptyContext = { pp: {}, crec: {} };
  for (const [i, action] of actions.entries()) {
    if (action.enabled === false) continue;
    const at = { actionIndex: i + 1, actionCode: String(action.code ?? "") };
    // 設定画面の baseKey と同じ: アプリ種別と「まとめて 1 回 / グループごと」はレコード文脈が無い
    const noRecord = action.type === "app" || engine.api.isSelectionNoRecord(action as never);
    const base: "record" | "none" = noRecord ? "none" : "record";
    for (const slot of formulaSlots(action)) {
      const context = !contexts
        ? emptyContext
        : slot.where.startsWith("resultMessage")
          ? contexts.result(base)
          : slot.where.startsWith("groupFormula")
            ? contexts.record // 分ける式はレコードごとに評価する
            : contexts[base];
      const r = engine.api.checkFormula(context, slot.raw) as { ok: boolean; msg?: string };
      if (r.ok) continue;
      const unknown = UNKNOWN_NAME_RE.exec(r.msg ?? "");
      if (unknown && !contexts) {
        // 項目名・関数名の誤りは項目定義が無いと区別できない。ただし項目コードに入らない文字が混じっていれば引用符の抜け
        if (NOT_A_FIELD_CODE.test(unknown[1] ?? "")) {
          findings.push({
            level: "warning",
            code: "pFormulaQuote",
            message: `${slot.where}: 引用符 " の抜けかもしれない（固定の文も "…" で囲む。囲まないと項目コードとして読まれる）`,
            ...at,
          });
        }
        continue;
      }
      if (unknown) {
        // 項目定義があるので「項目が無い」は本当の誤り（名前だけ出す。式は出さない）
        findings.push({
          level: "error",
          code: "pFormulaField",
          message: `${slot.where}: 「${(unknown[1] ?? "").slice(0, 64)}」という項目も関数も無い（項目コードで書く。表示名ではない。使えない文脈のことも）`,
          ...at,
        });
        continue;
      }
      findings.push({
        level: "error",
        code: "pFormulaSyntax",
        message: `${slot.where}: 式の構文が通らない（引用符 " と括弧の対応を確かめる）`,
        ...at,
      });
    }
  }
  return findings;
}

export interface CheckOptions extends LoadEngineOptions {
  /**
   * 自アプリの項目定義（`kact_fields` が置いた控えの `properties`）。渡すと計算式を
   * **設定画面の保存と同じ検査**（項目コード・関数名まで）に上げる。無ければ構文だけ見る
   */
  fields?: Record<string, unknown>;
  /** 項目定義を渡すときの自アプリの番号（`loadFormulaContext` に渡す。省略時は封筒の appId） */
  appId?: number;
}

/**
 * 設定ファイルの検査（kact_check）。**設定画面の保存と同じ規則**を zip の API で通す。
 * - 形（CONFIG_SCHEMA）と横断の検査（validateConfig）
 * - アクションごとに SQL の検査（checkActionSql。注意も返す）
 * - 計算式は、項目定義（`fields`）を渡せば**設定画面の保存と同じ検査**、無ければ**構文だけ**（`checkFormulas`）
 */
export async function checkConfig(text: string, opt: CheckOptions = {}): Promise<CheckResult> {
  let engine: Engine;
  try {
    engine = await loadEngine(opt);
  } catch (e) {
    const info = e instanceof PluginZipError ? e : undefined;
    return { status: "failed", findings: [{ level: "error", code: info?.code ?? "engine-load-failed", message: e instanceof Error ? e.message : String(e) }] };
  }

  const findings: Finding[] = [];
  let config: Record<string, unknown>;
  let envelope: Record<string, unknown>;
  try {
    ({ config, envelope } = parseConfigFile(engine, text));
  } catch (e) {
    return { status: "invalid", findings: [{ level: "error", code: "parse-failed", message: e instanceof Error ? e.message : String(e) }] };
  }

  // 1 形（スキーマ）
  try {
    engine.api.validateSchema(config);
  } catch (e) {
    findings.push({ level: "error", code: "schema", message: e instanceof Error ? e.message : String(e) });
  }

  // 2 横断の検査（コードの重複・イベントの整合など）
  for (const issue of engine.api.validateConfig(config as never) as string[]) {
    findings.push({ level: "error", code: "config", message: issue });
  }

  // 3 アクションごとの SQL
  const actions = Array.isArray(config.actions) ? (config.actions as Array<Record<string, unknown>>) : [];
  const bindings = (Array.isArray(config.bindings) ? config.bindings : []) as Array<{ name: string; appId: number }>;
  for (const [i, action] of actions.entries()) {
    if (action.enabled === false) continue;
    const r = (await engine.api.checkActionSql(action as never, bindings)) as {
      problems: Array<{ code: string; detail?: string; index?: number; kind?: string }>;
      warnings: Array<{ code: string; message: string }>;
    };
    const at = { actionIndex: i + 1, actionCode: String(action.code ?? "") };
    for (const p of r.problems) {
      findings.push({ level: "error", code: p.code, message: [p.detail, p.index ? `文 ${p.index}` : "", p.kind].filter(Boolean).join(" / ") || p.code, ...at });
    }
    for (const w of r.warnings) findings.push({ level: "warning", code: w.code, message: w.message, ...at });
  }

  // 4 計算式（項目定義があれば設定画面と同じ検査、無ければ構文だけ）
  let contexts: FormulaContexts | undefined;
  if (opt.fields) {
    const appId = opt.appId ?? Number(envelope.appId ?? 0);
    if (!Number.isSafeInteger(appId) || appId <= 0) {
      findings.push({ level: "warning", code: "fields-no-app", message: "項目定義を渡されたが自アプリの番号が分からないので、計算式は構文だけ見た" });
    } else {
      try {
        contexts = await contextsFrom(engine, opt.fields, appId);
      } catch (e) {
        findings.push({ level: "warning", code: "fields-context-failed", message: `項目定義から計算式の文脈を作れなかったので構文だけ見た: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }
  findings.push(...checkFormulas(engine, actions, contexts));

  const enabled = actions.filter((a) => a.enabled !== false).length;
  return {
    status: findings.some((f) => f.level === "error") ? "invalid" : "ok",
    summary: {
      actions: actions.length,
      enabled,
      bindings: bindings.map((b) => `${b.name}=${b.appId}`),
      logApp: !!config.logApp,
      sqlLines: actions.map((a) => String(a.sql ?? "").split("\n").length),
      /** 計算式をどこまで見たか（項目コードまで見たか、構文だけか） */
      formulaCheck: contexts ? "fields" : "syntax",
    },
    findings,
  };
}

export interface ActionSummary {
  index: number;
  code: string;
  name: string;
  enabled: boolean;
  /** 種類（`record` / `app`。2026-10-31 に 3 つから 2 つになった） */
  type: string;
  /** 一覧画面でも使う（種類 record だけ。選んだレコードに実行） */
  onList: boolean;
  placements: string[];
  /** 一覧パネルの区分（空 = 区分なし） */
  panelSection: string;
  /** 一覧の選択の渡し方（「一覧でも使う」のときだけ意味がある） */
  selectionMode?: string;
  confirm: boolean;
  writeLimit: number;
  /** SQL の行数と、使っている文の種類（本文は返さない） */
  sqlLines: number;
  /** テーブルへの書き戻し（APPLY）を含むか */
  apply: boolean;
  params: string[];
  inputs: string[];
}

/** 設定の中身を一覧（kact_actions）。**SQL 本文と値は返さない** */
export async function listActions(text: string, opt: LoadEngineOptions = {}): Promise<{ status: ToolStatus; actions?: ActionSummary[]; findings: Finding[] }> {
  let engine: Engine;
  try {
    engine = await loadEngine(opt);
  } catch (e) {
    return { status: "failed", findings: [{ level: "error", code: "engine-load-failed", message: e instanceof Error ? e.message : String(e) }] };
  }
  let config: Record<string, unknown>;
  try {
    ({ config } = parseConfigFile(engine, text));
  } catch (e) {
    return { status: "invalid", findings: [{ level: "error", code: "parse-failed", message: e instanceof Error ? e.message : String(e) }] };
  }
  const actions = (Array.isArray(config.actions) ? config.actions : []) as Array<Record<string, unknown>>;
  return {
    status: "ok",
    actions: actions.map((a, i) => ({
      index: i + 1,
      code: String(a.code ?? ""),
      name: String(a.name ?? ""),
      enabled: a.enabled !== false,
      type: String(a.type ?? ""),
      onList: a.onList === true,
      placements: (Array.isArray(a.placements) ? a.placements : []).map(String),
      panelSection: String(a.panelSection ?? ""),
      // 渡し方は「一覧でも使う」のときだけ効く（2026-10-31 に種類 list をやめた）
      ...(a.onList === true ? { selectionMode: String(a.selectionMode ?? "loop") } : {}),
      confirm: !!a.confirm,
      writeLimit: Number(a.writeLimit ?? 0),
      sqlLines: String(a.sql ?? "").split("\n").length,
      apply: /\bAPPLY\b/i.test(String(a.sql ?? "")),
      params: (Array.isArray(a.params) ? a.params : []).map((p) => String((p as { name?: unknown }).name ?? "")),
      inputs: (Array.isArray(a.inputs) ? a.inputs : []).map((p) => String((p as { name?: unknown }).name ?? "")),
    })),
    findings: [],
  };
}

/** ファイルから読む版（CLI と MCP の入口で使う。パスの検査は呼び出し側） */
export function readTextFile(file: string): string {
  return readFileSync(file, "utf8");
}
