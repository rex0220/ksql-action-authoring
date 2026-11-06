/**
 * tools の版と、扱うkSQL アクションの zip の決まり（docs/authoring-plan.md 12.1、12.2 の version、12.18）。
 * エンジンとkSQL アクションのコードは利用者の zip から読むので、ビルド時に埋めるのは tools の版と commit だけ。kSQL アクションの版は実行時に zip から分かる。
 * 1.1.0（2026-10-08 Takashi「pluginid のチェックのみで OK」）: zip のコードを実行してよいかは、外側の zip の PUBKEY から出るプラグイン ID が
 * kSQL アクションのもの（KSQL_ACTION_PLUGIN_ID）かで決める。版は MIN_PLUGIN_VERSION 以上、API の版は SUPPORTED_API_VERSIONS のどれか（engine.ts）。
 * 1.0.0 までは 4 ファイルの SHA-256 の組を既知のリリースと照合していた（1-10 レビュー BLOCKER 2）ので、kSQL アクションの zip が変わるたびに tools の公開が要った。
 * ID は PUBKEY から計算するだけで、SIGNATURE は検証しない（Takashi 判断。本物の zip の PUBKEY を写した zip も通る）。
 * kSQL アクションの AUTHORING_API_VERSION が上がったら SUPPORTED_API_VERSIONS に足す（ksql-action の CLAUDE.md）。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AUTHORING_ROOT } from "./paths.ts";

declare const __KACT_TOOLS_META__: string | undefined;

/** kSQL アクションプラグインの kintone のプラグイン ID（PUBKEY の SHA-256 から。plugin-zip.ts の pluginIdOf。5 変種とも同じ鍵） */
export const KSQL_ACTION_PLUGIN_ID = "afkekkiffjhdkcepekecalklafjhbcmf";
/** tools が扱う kSQL アクションの版の下限（manifest.json の version。authoring API は Ver.1 から同梱） */
export const MIN_PLUGIN_VERSION = 1;
/** tools が対応する authoring API の版（ksql-action の src/authoring/api.ts の AUTHORING_API_VERSION） */
export const SUPPORTED_API_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8];

/** kSQL アクションの版として扱えるか（整数で MIN_PLUGIN_VERSION 以上） */
export function isSupportedPluginVersion(version: string): boolean {
  return /^[1-9]\d{0,5}$/.test(version) && Number(version) >= MIN_PLUGIN_VERSION;
}

/**
 * tools が使う authoring API のキーと型（契約。zip の API がこの形でなければ止める）。
 * 中身は ksql-action の `src/authoring/api.ts`（apiVersion 1）と対で保つ。
 */
export const REQUIRED_API: Record<string, "function" | "object" | "string" | "number"> = {
  apiVersion: "number", pluginVersion: "string", pluginIdName: "string",
  // 設定の形と既定値
  CONFIG_SCHEMA: "object", LIMITS: "object", limits: "object", EVENT_PLACEMENTS: "object",
  defaultConfig: "function", defaultAction: "function", defaultLimits: "function", migrateConfig: "function",
  // 検査（設定画面の保存と同じ規則）
  validateConfig: "function", validateSchema: "function", ValidationError: "function",
  checkActionSql: "function", reservedNamesFor: "function", appsOf: "function",
  // テーブルへの書き戻しと選択の分け方
  applyShapeOf: "function", applyMutationNeeded: "function", groupSelection: "function",
  isSelectionOnce: "function", isSelectionGrouped: "function", isSelectionNoRecord: "function",
  // 計算式
  formulaEngineLoaded: "function", checkFormula: "function", loadFormulaContext: "function",
  // 封筒形式
  buildExportData: "function", parseImport: "function"
};

/** 版 4 で足した計算式の評価（`kact_try` が使う。実行時と同じコードを公開したもの） */
export const API_V4: Record<string, "function"> = {
  evalFormula: "function", evalCondition: "function", toParamValue: "function", withResultRecord: "function"
};

/**
 * 版 5 で足したループの判定（計算式の文脈を選ぶのに使う。2026-11-06）。
 * **写すと本物とずれる**ので本体から公開してもらっている（`loop` がコメントを除いて空でないか）
 */
export const API_V5: Record<string, "function"> = { hasLoop: "function" };

/**
 * 版 6（2026-11-06）で足した口は**無い**。結果の変数の接頭辞が
 * `_result_` → `$result_` に変わっただけ（tools が案内する名前が変わるので版を上げた）。
 * 要るキーは版 5 と同じ。
 */

/**
 * 版 7（2026-11-06）で足した**共通の文（`messages`）と多言語**の口。
 *
 * 決まり（書ける式の口・擬似項目の作り方・参照の取り出し・言語の解き方）は**本体が正本**で、
 * tools は写さない（本体の Codex レビュー MAJOR 5。写すと本物とずれる）。
 * **`checkActionSql` の `options.messages` もこの版から要る**（渡さないと `DECLARE @m_…` が
 * 「表に無い」で error になる＝黙って通さない向き）。
 */
export const API_V7: Record<string, "function" | "object" | "string" | "number"> = {
  MESSAGE_SLOTS: "object",
  slotAllowsMessages: "function",
  MESSAGE_CODE_RE: "object",
  MESSAGE_PREFIX: "string",
  normalizeMessages: "function",
  messageFields: "function",
  messageTexts: "function",
  messageValues: "function",
  messageRefsOfAction: "function",
  sqlMessageRefs: "function",
  messageUsage: "function",
  actionName: "function",
  actionDescription: "function",
  panelTitle: "function",
  sectionLabel: "function",
  inputLabel: "function",
  inputOptionLabels: "function",
  LANGS: "object",
  measureConfigBytes: "function",
  CONFIG_MAX_BYTES: "number",
};

/**
 * その版の zip の API に要るキーと型（ksql-action の api.ts の `AUTHORING_API_VERSION` と対）。
 * **古い版の zip も動かす**（足した口を使うツールだけが「zip が古い」と断る）。
 * **版を名乗る以上その口は揃っていること**を見る（2026-11-06 の Codex レビュー〈2 回目〉MINOR 1。
 * `apiVersion: 5` と名乗りながら `hasLoop` が無い zip を、黙って古い文脈に落として通していた）
 */
export function requiredApiFor(apiVersion: number): Record<string, "function" | "object" | "string" | "number"> {
  const api = { ...REQUIRED_API };
  if (apiVersion >= 4) Object.assign(api, API_V4);
  if (apiVersion >= 5) Object.assign(api, API_V5);
  if (apiVersion >= 7) Object.assign(api, API_V7);
  return api;
}

export interface ToolsMeta {
  toolsVersion: string;
  /** 扱うkSQL アクションの zip のプラグイン ID */
  pluginId: string;
  /** 扱うkSQL アクションの版の下限 */
  minPluginVersion: number;
  supportedApiVersions: number[];
  /** tools のリポジトリ（ksql-action-authoring）の commit（作業ツリーに変更があれば +dirty） */
  commit: string;
  builtAt: string;
  mode: "build" | "dev";
}

/** RegExp を文字列にして JSON にする（CONFIG_SCHEMA の pattern を落とさない） */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (x instanceof RegExp ? `/${x.source}/${x.flags}` : x));
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** CONFIG_SCHEMA のハッシュ（先頭 12 桁）。kSQL アクションの API から受けた schema で計算する */
export function schemaRevisionOf(schema: unknown): string {
  return sha256Hex(stableJson(schema)).slice(0, 12);
}

export function gitCommit(dir: string): string {
  try {
    const head = execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["-C", dir, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() !== "";
    return dirty ? `${head}+dirty` : head;
  } catch {
    return "unknown";
  }
}

export function devMeta(): ToolsMeta {
  const pkg = JSON.parse(readFileSync(path.join(AUTHORING_ROOT, "package.json"), "utf8")) as { version: string };
  return { toolsVersion: pkg.version, pluginId: KSQL_ACTION_PLUGIN_ID, minPluginVersion: MIN_PLUGIN_VERSION, supportedApiVersions: [...SUPPORTED_API_VERSIONS], commit: gitCommit(AUTHORING_ROOT), builtAt: "", mode: "dev" };
}

export function toolsMeta(): ToolsMeta {
  if (typeof __KACT_TOOLS_META__ === "string") return JSON.parse(__KACT_TOOLS_META__) as ToolsMeta;
  return devMeta();
}
