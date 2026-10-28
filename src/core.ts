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

export type ToolStatus = "ok" | "invalid" | "incompatible" | "failed";

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
  findings: Finding[];
}

/** zip と tools の診断（kact_status）。zip の場所は呼び出し側が決めて渡す */
export async function statusOf(opt: LoadEngineOptions = {}): Promise<StatusResult> {
  const tools = toolsMeta();
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
      findings,
    };
  } catch (e) {
    const info = e instanceof PluginZipError ? e : undefined;
    return {
      status: info && (info.code === "unsupported-version" || info.code === "api-unsupported") ? "incompatible" : "failed",
      tools,
      findings: [{ level: "error", code: info?.code ?? "engine-load-failed", message: e instanceof Error ? e.message : String(e) }],
    };
  }
}

/** 封筒形式の設定ファイルを読む（`parseImport` は pluginID と形を確かめる） */
function parseConfigFile(engine: Engine, text: string): { config: Record<string, unknown>; envelope: Record<string, unknown> } {
  const parsed = engine.api.parseImport(text, String(engine.api.pluginIdName), engine.api.CONFIG_SCHEMA) as {
    data: Record<string, unknown>;
    envelope: Record<string, unknown>;
  };
  // 保存済みの古い形を今の形に直してから検査する（設定画面の読み込みと同じ）
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
  };
  findings: Finding[];
}

/**
 * 設定ファイルの検査（kact_check）。**設定画面の保存と同じ規則**を zip の API で通す。
 * - 形（CONFIG_SCHEMA）と横断の検査（validateConfig）
 * - アクションごとに SQL の検査（checkActionSql。注意も返す）
 * - 計算式（表示条件・実行条件・結果メッセージ・パラメーター・分ける式）は `fields` を渡したときだけ
 */
export async function checkConfig(text: string, opt: LoadEngineOptions = {}): Promise<CheckResult> {
  let engine: Engine;
  try {
    engine = await loadEngine(opt);
  } catch (e) {
    const info = e instanceof PluginZipError ? e : undefined;
    return { status: "failed", findings: [{ level: "error", code: info?.code ?? "engine-load-failed", message: e instanceof Error ? e.message : String(e) }] };
  }

  const findings: Finding[] = [];
  let config: Record<string, unknown>;
  try {
    ({ config } = parseConfigFile(engine, text));
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

  const enabled = actions.filter((a) => a.enabled !== false).length;
  return {
    status: findings.some((f) => f.level === "error") ? "invalid" : "ok",
    summary: {
      actions: actions.length,
      enabled,
      bindings: bindings.map((b) => `${b.name}=${b.appId}`),
      logApp: !!config.logApp,
      sqlLines: actions.map((a) => String(a.sql ?? "").split("\n").length),
    },
    findings,
  };
}

export interface ActionSummary {
  index: number;
  code: string;
  name: string;
  enabled: boolean;
  type: string;
  placements: string[];
  /** 一覧の選択の渡し方（種類 list のときだけ意味がある） */
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
      placements: (Array.isArray(a.placements) ? a.placements : []).map(String),
      ...(a.type === "list" ? { selectionMode: String(a.selectionMode ?? "loop") } : {}),
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
