/**
 * 設定ファイルの保存（段階 2）。`kact_save_config` / `kact_update_action` / `kact_pull` / `kact_files` の中核。
 *
 * 保存の約束（印刷屋のオーサリング tools と同じ。`commit-file.ts` が確定とロックを受け持つ）:
 * - **作業フォルダーの中だけ**に書く（相対パス・realpath で確かめる。`workspace.ts`）
 * - **新規は上書きしない**（同じ名前があれば `conflict`。別の名前にするか、更新なら `kact_update_action`）
 * - **更新は `expectedDigest` の照合**（読んだ後に変わっていたら `conflict`）。確定の直前にもう一度確かめる
 * - **検査を通らない設定は書かない**（`checkConfig` のエラー = プラグインの保存と同じ規則。注意は書いてから伝える）
 * - 返りは `{ status, findings }`（ok / invalid / conflict / denied / failed）。SQL 本文と値は返さない
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acquireLock, cleanupAll, placeNew, tempPathFor, withRetry, FileExistsError, LockBusyError, type Lock } from "./commit-file.ts";
import { loadEngine, type Engine, type LoadEngineOptions } from "./engine.ts";
import { checkConfig, type Finding, type ToolStatus } from "./core.ts";
import { actionDiff } from "./diff.ts";
import { listWorkspaceFiles, MAX_CONFIG_BYTES, resolveInWorkspace, resolveNewInWorkspace, workspaceDir, WorkspaceError, type WorkspaceFile } from "./workspace.ts";

/** 封筒のキー（これ以外が設定の本体） */
const ENVELOPE_KEYS = ["date", "pluginName", "pluginID", "PluginVersion", "appId", "appName"];
/** 設定を書き出したプラグインの表示名（設定画面の日本語と同じ。表示だけに使う） */
const PLUGIN_DISPLAY_NAME = "kSQL アクション";

export function digestOf(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 封筒でも本体でも受ける（封筒のキーを外す） */
function bodyOf(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (!ENVELOPE_KEYS.includes(k)) out[k] = v;
  return out;
}

/**
 * 足りないキーを**本体の既定値**で埋める（AI は変えるところだけ書けばよい）。
 * 埋めた後の形は、設定画面の保存とまったく同じ検査（`validateSchema` / `validateConfig` / `checkActionSql`）で確かめる。
 */
function withDefaults(engine: Engine, body: Record<string, unknown>): Record<string, unknown> {
  const api = engine.api;
  const base = api.defaultConfig() as Record<string, unknown>;
  const limits = { ...(api.defaultLimits() as unknown as Record<string, unknown>), ...(isObject(body.limits) ? body.limits : {}) };
  const actions = (Array.isArray(body.actions) ? body.actions : []).map((a) => actionWithDefaults(engine, a));
  return { ...base, ...body, limits, actions };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function actionWithDefaults(engine: Engine, action: unknown): Record<string, unknown> {
  if (!isObject(action)) return {};
  const code = typeof action.code === "string" ? action.code : "";
  const name = typeof action.name === "string" ? action.name : code;
  const merged = { ...(engine.api.defaultAction(code, name) as Record<string, unknown>), ...action };
  if (Array.isArray(action.params)) merged.params = action.params.map(paramWithDefaults);
  if (Array.isArray(action.inputs)) merged.inputs = action.inputs.map(inputWithDefaults);
  return merged;
}

/**
 * `params[]` / `inputs[]` の中のキーも埋める（本体の API に `defaultParam` / `defaultInput` は無いので、
 * `CONFIG_SCHEMA` が求めるキーをここで補う。スキーマは中のキーも**すべて必須**）。
 * `inputs[].options` は `type: "text"` でも必須で、2026-10-28 の試用（S2）でここに落ちた。
 * **`name` は補わない**（推測で空の名前にすると `DECLARE` の突き合わせで落ちて、原因が分かりにくい）。
 */
function paramWithDefaults(param: unknown): Record<string, unknown> {
  if (!isObject(param)) return {};
  return { source: "formula", formula: "", ...param };
}

function inputWithDefaults(input: unknown): Record<string, unknown> {
  if (!isObject(input)) return {};
  // 見出しが無ければ名前をそのまま出す（画面に出る文字なので空にしない）
  const label = typeof input.name === "string" ? input.name : "";
  return { label, type: "text", required: false, defaultFormula: "", options: [], ...input };
}

export interface SaveResult {
  status: ToolStatus;
  /** 作業フォルダーからの相対パス（書いたとき） */
  path?: string;
  /** 書いたファイルの digest（`kact_update_action` の `expectedDigest` に渡す） */
  digest?: string;
  summary?: { actions: number; enabled: number; bindings: string[]; logApp: boolean; sqlLines: number[] };
  findings: Finding[];
  /** 利用者に伝える一言（決まった文。ファイルの中身・値は入れない） */
  message?: string;
  /**
   * 直したアクションの差（`kact_update_action` だけ。変わっていなければ無し）。
   * 同じファイルを書き替えるので `kact_diff` の `before` が残らないため、ここで返す（2026-10-28 の試用 S3）。
   */
  changes?: string;
}

const fail = (code: string, message: string, status: ToolStatus = "failed"): SaveResult => ({ status, findings: [{ level: "error", code, message }] });

/** WorkspaceError を返りの形に（outside = denied、ほかは invalid） */
function fromWorkspaceError(e: unknown): SaveResult {
  if (e instanceof WorkspaceError) return fail(`workspace-${e.code}`, e.message, e.code === "outside" ? "denied" : "invalid");
  return fail("workspace", e instanceof Error ? e.message : String(e));
}

async function engineOf(opt: LoadEngineOptions): Promise<Engine | SaveResult> {
  try {
    return await loadEngine(opt);
  } catch (e) {
    return fail("engine-load-failed", e instanceof Error ? e.message : String(e));
  }
}

const isResult = (v: Engine | SaveResult): v is SaveResult => "findings" in v;

/** 一時ファイルを書き、ロックを取って確かめ直してから確定する（印刷屋の save.ts の commit と同じ段取り） */
function commit(target: string, text: string, mode: "new" | "replace", recheck: () => void): { digest: string; cleanup: string[] } {
  const tmp = tempPathFor(target);
  let lock: Lock | undefined;
  let digest: string | undefined;
  let failure: unknown;
  try {
    recheck();
    writeFileSync(tmp, text, { encoding: "utf8", flag: "wx" });
    lock = acquireLock(target);
    recheck(); // 確定の直前にもう一度（同じ名前ができた・digest が変わった）
    if (!lock.owned()) throw new LockBusyError("ロックを失った（保存が 60 秒より長く止まった）。kact_actions で読み直してやり直す");
    if (mode === "new") withRetry(() => placeNew(tmp, target));
    else withRetry(() => renameSync(tmp, target));
    digest = digestOf(text);
  } catch (e) {
    failure = e;
  }
  const cleanup = cleanupAll([...(lock ? [() => void lock!.release()] : []), () => rmSync(tmp, { force: true })]);
  if (digest === undefined) throw failure;
  return { digest, cleanup };
}

/** 確定のときの例外を返りの形に */
function fromCommitError(e: unknown): SaveResult {
  if (e instanceof FileExistsError) return fail("exists", "同じ名前のファイルができた。別の名前にする", "conflict");
  if (e instanceof LockBusyError) return fail("busy", e.message, "conflict");
  if (e instanceof WorkspaceError) return fromWorkspaceError(e);
  return fail("write-failed", e instanceof Error ? e.message : String(e));
}

/** 検査（設定画面の保存と同じ規則）。エラーがあれば書かない */
async function checkOrFail(text: string, opt: LoadEngineOptions): Promise<{ ok: true; findings: Finding[]; summary: SaveResult["summary"] } | { ok: false; result: SaveResult }> {
  const r = await checkConfig(text, opt);
  if (r.status !== "ok") {
    return { ok: false, result: { status: r.status, findings: r.findings, message: "検査を通らないので書いていない（findings を直してやり直す）" } };
  }
  return { ok: true, findings: r.findings, summary: r.summary };
}

export interface SaveConfigInput {
  /** 作業フォルダーからの相対パス（`.json`。例 settings/kact-1001.json） */
  file: string;
  /** 取り込む先のアプリ ID（封筒に入る。利用者に聞く） */
  appId: number;
  appName?: string;
  /** 設定の本体（`configVersion` / `bindings` / `limits` / `timezone` / `actions`）か、封筒ごと */
  config: unknown;
  now?: () => Date;
}

/** 新しい設定ファイルを検査して保存する（上書きしない） */
export async function saveConfig(input: SaveConfigInput, opt: LoadEngineOptions = {}): Promise<SaveResult> {
  const engine = await engineOf(opt);
  if (isResult(engine)) return engine;
  if (!isObject(input.config)) return fail("input", "config は設定の本体（または封筒）のオブジェクトで渡す", "invalid");
  if (!Number.isInteger(input.appId) || input.appId <= 0) return fail("input", "appId は 1 以上の整数（取り込む先のアプリ。推測せず利用者に聞く）", "invalid");

  let target: string;
  const dir = (() => {
    try {
      return workspaceDir();
    } catch {
      return undefined;
    }
  })();
  if (!dir) return fail("workspace-not-found", "作業フォルダーが見つからない（KACT_WORKSPACE）");
  try {
    target = resolveNewInWorkspace(input.file, dir);
  } catch (e) {
    return fromWorkspaceError(e);
  }
  if (existsSync(target)) {
    return { status: "conflict", findings: [{ level: "error", code: "exists", message: "同じ名前のファイルがある。別の名前にするか、アクションを直すなら kact_update_action を使う" }], path: input.file };
  }

  const body = withDefaults(engine, bodyOf(input.config));
  const envelope = engine.api.buildExportData(
    { pluginName: PLUGIN_DISPLAY_NAME, pluginId: String(engine.api.pluginIdName), pluginVersion: String(engine.api.pluginVersion), appId: input.appId, appName: input.appName ?? "" },
    body,
    (input.now ?? (() => new Date()))(),
  ) as Record<string, unknown>;
  const text = JSON.stringify(envelope);
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) return fail("too-large", `設定が大きすぎる（${MAX_CONFIG_BYTES.toLocaleString()} バイトまで）`, "invalid");

  const checked = await checkOrFail(text, opt);
  if (!checked.ok) return checked.result;

  try {
    const { digest, cleanup } = commit(target, text, "new", () => {
      if (resolveNewInWorkspace(input.file, dir) !== target) throw new WorkspaceError("書く先が途中で変わった（symlink など）", "outside");
      if (existsSync(target)) throw new FileExistsError("確定の直前に同じ名前のファイルができた");
    });
    return {
      status: "ok",
      path: input.file,
      digest,
      summary: checked.summary,
      findings: checked.findings,
      message: cleanup.length ? "書いたが、一時ファイルかロックを消せなかった（. で始まる同じ名前のファイルを消してよい）" : undefined,
    };
  } catch (e) {
    return fromCommitError(e);
  }
}

export interface UpdateActionInput {
  file: string;
  /** 読んだ時点の digest（`kact_actions` が返す）。違えば conflict */
  expectedDigest: string;
  /** 差し替える・足すアクション（足りないキーは既定値で埋める） */
  action: unknown;
  /** 差し替える相手のコード（省略すると `action.code` と同じコードの行。無ければ末尾に足す） */
  replaceCode?: string;
  now?: () => Date;
}

/** 既存の設定のアクションを 1 つ差し替える・足す（`expectedDigest` で照合してから書く） */
export async function updateAction(input: UpdateActionInput, opt: LoadEngineOptions = {}): Promise<SaveResult> {
  const engine = await engineOf(opt);
  if (isResult(engine)) return engine;
  if (!isObject(input.action)) return fail("input", "action はアクションのオブジェクトで渡す", "invalid");
  if (typeof input.action.code !== "string" || !input.action.code) return fail("input", "action.code が要る（32 字まで。ロックキーとログに使う名前）", "invalid");
  if (!input.expectedDigest) return fail("input", "expectedDigest が要る（kact_actions で読んだ digest）", "invalid");

  let target: string;
  try {
    target = resolveInWorkspace(input.file);
  } catch (e) {
    return fromWorkspaceError(e);
  }
  const current = readFileSync(target, "utf8");
  if (digestOf(current) !== input.expectedDigest) {
    return { status: "conflict", findings: [{ level: "error", code: "digest", message: "読んだ後にファイルが変わった（digest が違う）。kact_actions で読み直してやり直す" }], path: input.file };
  }

  let envelope: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(current);
    if (!isObject(parsed)) throw new Error("設定ファイルがオブジェクトでない");
    envelope = parsed;
  } catch (e) {
    return fail("parse-failed", e instanceof Error ? e.message : String(e), "invalid");
  }

  const body = bodyOf(envelope);
  const actions = (Array.isArray(body.actions) ? body.actions : []) as Array<Record<string, unknown>>;
  const wanted = (input.replaceCode ?? input.action.code).toLowerCase();
  const at = actions.findIndex((a) => String(a.code ?? "").toLowerCase() === wanted);
  const next = actionWithDefaults(engine, at >= 0 ? { ...actions[at], ...input.action } : input.action);
  const nextActions = at >= 0 ? actions.map((a, i) => (i === at ? next : a)) : [...actions, next];

  const text = JSON.stringify({ ...envelope, date: formatDate((input.now ?? (() => new Date()))()), ...bodyOf({ ...body, actions: nextActions }) });
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) return fail("too-large", `設定が大きすぎる（${MAX_CONFIG_BYTES.toLocaleString()} バイトまで）`, "invalid");

  const checked = await checkOrFail(text, opt);
  if (!checked.ok) return checked.result;

  try {
    const { digest, cleanup } = commit(target, text, "replace", () => {
      if (resolveInWorkspace(input.file) !== target) throw new WorkspaceError("書く先が途中で変わった（symlink など）", "outside");
      if (digestOf(readFileSync(target)) !== input.expectedDigest) throw new LockBusyError("確定の直前にファイルが変わった（digest が違う）。kact_actions で読み直してやり直す");
    });
    const changes = actionDiff(String(input.action.code), at >= 0 ? actions[at] : undefined, next).join("\n");
    return {
      status: "ok",
      path: input.file,
      digest,
      summary: checked.summary,
      findings: checked.findings,
      message: `${at >= 0 ? "差し替えた" : "足した"}アクション: ${String(input.action.code)}${cleanup.length ? "（一時ファイルかロックを消せなかった。. で始まる同じ名前のファイルを消してよい）" : ""}`,
      ...(changes ? { changes } : {}),
    };
  } catch (e) {
    return fromCommitError(e);
  }
}

/** 封筒の date と同じ形（設定画面の書き出しに合わせる） */
function formatDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface PullInput {
  /** 設定画面の［設定をダウンロード］で取ったファイル（作業フォルダーからの相対パス。例 inbox/kact-app1001.json） */
  from: string;
  /** 写す先（省略すると settings/APP<アプリ ID>.json） */
  to?: string;
}

/**
 * ダウンロードした設定ファイルを作業フォルダーに取り込む（直すときの元）。
 * **元のファイルは残す**（書き換えない）。検査は通らなくても写す（直すために取り込むので）。
 */
export async function pullConfig(input: PullInput, opt: LoadEngineOptions = {}): Promise<SaveResult> {
  const engine = await engineOf(opt);
  if (isResult(engine)) return engine;

  let from: string;
  try {
    from = resolveInWorkspace(input.from);
  } catch (e) {
    return fromWorkspaceError(e);
  }
  if (statSync(from).size > MAX_CONFIG_BYTES) return fail("too-large", `ファイルが大きすぎる（${MAX_CONFIG_BYTES.toLocaleString()} バイトまで）`, "invalid");
  const text = readFileSync(from, "utf8");

  // kSQL アクションの設定か（封筒の pluginID と形）。ここで落ちるものは写さない
  let appId = 0;
  try {
    const parsed = engine.api.parseImport(text, String(engine.api.pluginIdName), engine.api.CONFIG_SCHEMA) as { envelope: Record<string, unknown> };
    appId = Number(parsed.envelope.appId ?? 0);
  } catch (e) {
    return fail("parse-failed", e instanceof Error ? e.message : String(e), "invalid");
  }

  const to = input.to ?? `settings/APP${appId || "unknown"}.json`;
  let target: string;
  try {
    target = resolveNewInWorkspace(to);
  } catch (e) {
    return fromWorkspaceError(e);
  }
  if (existsSync(target)) {
    return { status: "conflict", findings: [{ level: "error", code: "exists", message: `写す先に同じ名前のファイルがある: ${to}。to で別の名前を渡す` }], path: to };
  }

  const check = await checkConfig(text, opt);
  try {
    const { digest, cleanup } = commit(target, text, "new", () => {
      if (existsSync(target)) throw new FileExistsError("確定の直前に同じ名前のファイルができた");
    });
    return {
      status: "ok",
      path: to,
      digest,
      summary: check.summary,
      findings: check.findings,
      message: `取り込んだ（元の ${input.from} は残している）。検査: ${check.status}${cleanup.length ? "。一時ファイルかロックを消せなかった" : ""}`,
    };
  } catch (e) {
    return fromCommitError(e);
  }
}

export interface FileEntry extends WorkspaceFile {
  /** kSQL アクションの設定ファイルか（封筒の pluginID と形が合う） */
  kact: boolean;
  /** 設定ファイルのときだけ: digest（kact_update_action に渡す）・アクションの数・アプリ */
  digest?: string;
  actions?: number;
  appId?: number;
}

/** 作業フォルダーの JSON の一覧（設定ファイルは digest とアクションの数も）。中身は返さない */
export async function filesOf(opt: LoadEngineOptions = {}): Promise<{ status: ToolStatus; dir?: string; files?: FileEntry[]; findings: Finding[] }> {
  const engine = await engineOf(opt);
  if (isResult(engine)) return { status: engine.status, findings: engine.findings };
  let dir: string;
  let list: WorkspaceFile[];
  try {
    dir = workspaceDir();
    list = listWorkspaceFiles(dir);
  } catch (e) {
    const r = fromWorkspaceError(e);
    return { status: r.status, findings: r.findings };
  }
  const files: FileEntry[] = list.map((f) => {
    if (f.bytes > MAX_CONFIG_BYTES) return { ...f, kact: false };
    try {
      const text = readFileSync(path.join(dir, f.path), "utf8");
      const parsed = engine.api.parseImport(text, String(engine.api.pluginIdName), engine.api.CONFIG_SCHEMA) as { data: Record<string, unknown>; envelope: Record<string, unknown> };
      const actions = Array.isArray(parsed.data.actions) ? parsed.data.actions.length : 0;
      return { ...f, kact: true, digest: digestOf(text), actions, appId: Number(parsed.envelope.appId ?? 0) };
    } catch {
      return { ...f, kact: false };
    }
  });
  return { status: "ok", dir, files, findings: [] };
}
