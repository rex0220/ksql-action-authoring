/**
 * 式の試し計算（`kact_try`）。kact の計算式の口に書く式を、**架空の値**で実際に評価して返す。
 *
 * 約束:
 * - 評価は**本体のオーサリング API（版 4）**に任せる（`evalFormula` / `evalCondition` / `toParamValue` /
 *   `withResultRecord`。実行時 `ksql-action/src/desktop/formula-run.ts` と同じコード）。
 *   **tools 側に真偽の判定や数値の文字列化を写さない**（写すと本物とずれる）。版 3 までの zip では使えない
 * - 文脈（`pp` / `crec`）は**本体の `loadFormulaContext`** が作る（`core.ts` の `contextsFrom`）。
 *   値だけをこちらで差し込む
 * - kintone には行かない。項目定義は `kact_fields` が置いた控えだけ。**値は AI か利用者が渡す架空のもの**
 */
import type { Finding, ToolStatus } from "./core.ts";
import { contextsFrom, type FormulaContexts } from "./core.ts";
import { loadEngine, type Engine, type LoadEngineOptions } from "./engine.ts";
import { findFieldsFile } from "./fields.ts";

/** レコードの 1 項目（kintone のレコードと同じ形。値は文字列・配列） */
interface Cell {
  type?: string;
  value?: unknown;
}

export interface TryFormula {
  /** 式（kact の計算式の口に書くもの） */
  formula: string;
  /** 何の口として見るか（返りの読み方が変わるだけで、評価は同じ）。省略は value */
  as?: "value" | "condition" | "param";
}

export interface TryInput {
  /** 自アプリの番号（`kact_fields` の控えを使う）。省略すると**項目の無い文脈**（種類 app と同じ） */
  app?: number;
  /** レコード文脈。省略は app があれば record、無ければ none */
  context?: "record" | "none";
  /** 架空の値（項目コード → 値。テーブルは行の配列）。書かない項目は空 */
  data?: Record<string, unknown>;
  /** 結果メッセージを試すときの `_result_*` の値（これを渡すと `_result_*` が使える文脈になる） */
  result?: Record<string, string | number>;
  /**
   * ループの 1 回ぶん（§5.7）。渡すと**パラメーターの式で `$val` / `$lno` が使える**文脈になる。
   * 足すのは本体の `withResultRecord`（実行時の `withLoopRecord` と同じ口）なので、
   * **`$val` は渡した値の型のまま**（数値を渡せば `2017 + $val` は足し算、文字列を渡せば連結）。
   * 回の並び（`3` → 0・1・2、`ARRAY(…)` → その要素）は**利用者 / AI が決めて 1 回ぶんを渡す**
   */
  loop?: { val: string | number; lno?: number };
  /** ログインユーザー（`LOGIN_INFO` を使う式のとき） */
  user?: { code?: string; name?: string; id?: string; email?: string };
  formulas: TryFormula[];
}

export interface TryValue {
  index: number;
  formula: string;
  as: "value" | "condition" | "param";
  ok: boolean;
  /** 評価した値（`evalFormula`。空の式は無し） */
  value?: unknown;
  /** 値の型（`typeof`。配列は "array"） */
  valueType?: string;
  /** 表示条件・実行条件として見たときの真偽（`evalCondition`。空の式は真） */
  condition?: boolean;
  /** パラメーターとして SQL に注入される文字列（`toParamValue`）。文字列・数値でなければ無し */
  param?: string;
  /** パラメーターにできない値のときの理由 */
  paramNg?: string;
  /** 評価の失敗（エンジンの文言） */
  error?: string;
}

export interface TryResult {
  status: ToolStatus;
  appId?: number;
  context?: "record" | "none";
  /** 項目定義の控え（作業フォルダーからの相対パス） */
  fieldsFrom?: string;
  /** `_result_*` を足した文脈か */
  withResult?: boolean;
  /** `$val` / `$lno` を足した文脈か（渡された回の値をそのまま返す） */
  loop?: { val: string | number; lno: number };
  results?: TryValue[];
  findings: Finding[];
  message?: string;
}

/** 1 回に試せる式の数（探索を続けさせない。formula MCP の fml_try と同じ） */
const MAX_FORMULAS = 10;
/** 架空の値のテーブルの行数の上限 */
const MAX_TABLE_ROWS = 20;

const fail = (code: string, message: string, status: ToolStatus = "failed"): TryResult => ({ status, findings: [{ level: "error", code, message }] });

/** 版 4 で足った評価の口 */
interface EvalApi {
  evalFormula(pp: unknown, record: unknown, raw: string): { ok: boolean; value?: unknown; msg?: string };
  evalCondition(pp: unknown, record: unknown, raw: string, emptyIs: boolean): boolean;
  toParamValue(value: unknown): { ok: boolean; value?: string };
  withResultRecord(pp: unknown, record: unknown, result: Record<string, string | number>): { pp: unknown; record: unknown };
}

function evalApiOf(engine: Engine): EvalApi | undefined {
  const api = engine.api as unknown as Record<string, unknown>;
  const names = ["evalFormula", "evalCondition", "toParamValue", "withResultRecord"];
  return names.every((n) => typeof api[n] === "function") ? (api as unknown as EvalApi) : undefined;
}

/** 値の型の名前（配列は "array"、null は "null"） */
function typeNameOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** kintone のレコードに入れる形に直す（数値も文字列。配列はそのまま） */
function cellValue(v: unknown): unknown {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => (typeof x === "number" ? String(x) : x));
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return v;
}

/** 選択肢を持つ型（`options` のキーが選べる値） */
const OPTION_TYPES = new Set(["CHECK_BOX", "MULTI_SELECT", "DROP_DOWN", "RADIO_BUTTON"]);
/** 選択肢を**複数**選べる型（値は配列） */
const MULTI_OPTION_TYPES = new Set(["CHECK_BOX", "MULTI_SELECT"]);

/**
 * 選択肢に無い値を名指しする（打ち間違いを拾う。計算式 MCP の `fml_try` と同じ考え）。
 * 項目定義の控えに `options` が無ければ見ない（取り直す前の控え）
 */
function optionProblems(where: string, prop: { type?: string; options?: unknown }, value: unknown): string[] {
  const type = String(prop.type ?? "");
  if (!OPTION_TYPES.has(type)) return [];
  const options = prop.options;
  if (!options || typeof options !== "object") return [];
  const allowed = Object.keys(options as Record<string, unknown>);
  if (!allowed.length) return [];
  const shown = allowed.join(" / ");
  const values = MULTI_OPTION_TYPES.has(type) ? (Array.isArray(value) ? value : [value]) : [value];
  const out: string[] = [];
  for (const v of values) {
    // 空は「未選択」なので通す（チェックボックスの [] と、ドロップダウンの "" ）
    if (v === "" || v === null || v === undefined) continue;
    if (!allowed.includes(String(v))) out.push(`${where}: 選択肢に無い値 "${String(v)}"（${shown}）`);
  }
  return out;
}

/**
 * 架空の値を検証用レコードに差し込む（`crec` の写しを作る）。
 * 項目定義にない項目コードと、選択肢に無い値は invalid（名指し）。テーブルは行の配列で渡す
 */
function applyData(
  pp: Record<string, { type?: string; options?: unknown; fields?: Record<string, unknown> }>,
  crec: Record<string, unknown>,
  data: Record<string, unknown>,
): { record: Record<string, unknown>; problems: string[] } {
  const record: Record<string, unknown> = { ...crec };
  const problems: string[] = [];
  for (const [code, raw] of Object.entries(data)) {
    const prop = pp[code];
    if (!prop) {
      problems.push(`data.${code}: その項目は項目定義に無い`);
      continue;
    }
    if (prop.type === "SUBTABLE") {
      if (!Array.isArray(raw)) {
        problems.push(`data.${code}: テーブルは行の配列で渡す（[{ 子のコード: 値 }]）`);
        continue;
      }
      if (raw.length > MAX_TABLE_ROWS) {
        problems.push(`data.${code}: テーブルの行は ${MAX_TABLE_ROWS} 行まで`);
        continue;
      }
      const children = (prop.fields ?? {}) as Record<string, { type?: string; options?: unknown }>;
      const rows: Array<{ value: Record<string, Cell> }> = [];
      for (const [i, row] of raw.entries()) {
        const cells: Record<string, Cell> = {};
        for (const [childCode, child] of Object.entries(children)) cells[childCode] = { type: child.type, value: "" };
        for (const [childCode, childValue] of Object.entries((row ?? {}) as Record<string, unknown>)) {
          if (!children[childCode]) {
            problems.push(`data.${code}[${i}].${childCode}: そのテーブルの子に無い`);
            continue;
          }
          problems.push(...optionProblems(`data.${code}[${i}].${childCode}`, children[childCode]!, childValue));
          cells[childCode] = { type: children[childCode]!.type, value: cellValue(childValue) };
        }
        rows.push({ value: cells });
      }
      record[code] = { type: "SUBTABLE", value: rows };
      continue;
    }
    problems.push(...optionProblems(`data.${code}`, prop, raw));
    record[code] = { type: prop.type, value: cellValue(raw) };
  }
  return { record, problems };
}

/**
 * 式を試す（`kact_try`）。式ごとに独立に評価する（1 つの誤りがほかを止めない）。
 * 返りには**渡された式そのもの**を入れる（どの結果がどの式か分かるように。設定ファイルの中身は読まない）
 */
export async function tryFormulas(input: TryInput, opt: LoadEngineOptions & { workspaceDir?: string } = {}): Promise<TryResult> {
  const formulas = input.formulas ?? [];
  if (!formulas.length) return fail("input", "formulas が空（1〜10 本の式を渡す）", "invalid");
  if (formulas.length > MAX_FORMULAS) return fail("input", `式は 1 回に ${MAX_FORMULAS} 本まで（探索を続けない）`, "invalid");
  if (input.app !== undefined && (!Number.isSafeInteger(input.app) || input.app <= 0)) return fail("input", "app はアプリの番号（正の整数）で渡す", "invalid");

  let engine: Engine;
  try {
    engine = await loadEngine(opt);
  } catch (e) {
    return fail("engine", e instanceof Error ? e.message : String(e), "incompatible");
  }
  const evalApi = evalApiOf(engine);
  if (!evalApi) {
    return fail(
      "api-too-old",
      `この zip の authoring API（版 ${String(engine.api.apiVersion)}）には式を評価する口が無い（kact_try は版 4 以降が要る）。kSQL アクションプラグインを新しい版にする`,
      "incompatible",
    );
  }
  if (!engine.api.formulaEngineLoaded()) return fail("formula-engine-missing", "計算式エンジンが読めないので式を評価できない", "incompatible");

  // 項目定義の控え（あれば）。文脈は本体の loadFormulaContext に作らせる
  let contexts: FormulaContexts | undefined;
  let fieldsFrom: string | undefined;
  const findings: Finding[] = [];
  if (input.app !== undefined) {
    const found = findFieldsFile(input.app, opt.workspaceDir);
    if (!found) {
      return fail("fields-missing", `アプリ ${input.app} の項目定義の控えが無い（先に kact_fields で取る）`, "invalid");
    }
    fieldsFrom = found.path;
    contexts = await contextsFrom(engine, found.file.properties as unknown as Record<string, unknown>, input.app);
  }
  const context: "record" | "none" = input.context ?? (contexts ? "record" : "none");
  if (context === "record" && !contexts) {
    return fail("input", "context: \"record\" には app（項目定義の控え）が要る", "invalid");
  }

  let pp: unknown = contexts && context === "record" ? contexts.record.pp : {};
  let base: Record<string, unknown> = (contexts && context === "record" ? (contexts.record.crec as Record<string, unknown>) : {}) as Record<string, unknown>;

  // 架空の値を差し込む（項目定義にない項目は invalid）
  if (input.data && Object.keys(input.data).length) {
    if (context !== "record") return fail("input", "data（架空の値）は context: \"record\" のときだけ使える（項目の無い文脈では値を持てない）", "invalid");
    const { record, problems } = applyData(pp as Record<string, { type?: string; fields?: Record<string, unknown> }>, base, input.data);
    if (problems.length) return { status: "invalid", findings: problems.map((p) => ({ level: "error" as const, code: "data", message: p })) };
    base = record;
  }

  // 結果メッセージの文脈（_result_* を足す）。足すのは本体の withResultRecord
  const withResult = !!input.result;
  if (input.result) {
    const r = evalApi.withResultRecord(pp, base, input.result);
    pp = r.pp;
    base = r.record as Record<string, unknown>;
  }

  /**
   * ループの回（§5.7）。`$val` / `$lno` を足すのも本体の `withResultRecord`（= 実行時の `withLoopRecord`）。
   * **パラメーターの式だけ**がこの文脈で評価される（ループの式そのもの・表示条件・実行条件・結果メッセージでは使えない）
   */
  let loop: { val: string | number; lno: number } | undefined;
  if (input.loop !== undefined) {
    const val = input.loop.val;
    if (typeof val !== "string" && typeof val !== "number") {
      return fail("input", "loop.val は文字列か数値で渡す（ループ値は SQL に注入できる型だけ）", "invalid");
    }
    if (typeof val === "number" && !Number.isFinite(val)) return fail("input", "loop.val が数でない（NaN・Infinity は渡せない）", "invalid");
    const lno = input.loop.lno ?? 0;
    if (!Number.isSafeInteger(lno) || lno < 0) return fail("input", "loop.lno は 0 以上の整数で渡す（回の番号は 0 から）", "invalid");
    loop = { val, lno };
    const r = evalApi.withResultRecord(pp, base, { $val: val, $lno: lno });
    pp = r.pp;
    base = r.record as Record<string, unknown>;
  }

  if (input.user) {
    engine.setContext({ loginUser: { id: "1", code: "", name: "", email: "", language: "ja", ...input.user } });
  }

  const results: TryValue[] = [];
  for (const [i, f] of formulas.entries()) {
    const as = f.as ?? "value";
    const raw = String(f.formula ?? "");
    const r = evalApi.evalFormula(pp, base, raw);
    if (!r.ok) {
      results.push({ index: i + 1, formula: raw, as, ok: false, error: r.msg ?? "評価に失敗した" });
      continue;
    }
    const param = evalApi.toParamValue(r.value);
    results.push({
      index: i + 1,
      formula: raw,
      as,
      ok: true,
      ...(r.value === undefined ? {} : { value: r.value, valueType: typeNameOf(r.value) }),
      condition: evalApi.evalCondition(pp, base, raw, true),
      ...(param.ok ? { param: param.value } : { paramNg: "文字列・数値でないので SQL に注入できない（パラメーターの式は文字列か数値を返す）" }),
    });
  }

  const ng = results.filter((r) => !r.ok).length;
  return {
    status: "ok",
    ...(input.app !== undefined ? { appId: input.app } : {}),
    context,
    ...(fieldsFrom ? { fieldsFrom } : {}),
    ...(withResult ? { withResult: true } : {}),
    ...(loop ? { loop } : {}),
    results,
    findings,
    message:
      `${results.length} 本を${context === "record" ? "レコード文脈" : "項目の無い文脈（種類 app と同じ）"}で評価した` +
      `${loop ? `（ループの回 $val=${JSON.stringify(loop.val)} / $lno=${String(loop.lno)}）` : ""}` +
      `${ng ? `（${ng} 本が失敗）` : ""}。**架空の値での模擬**で、利用者のレコードでは値が変わる。` +
      `condition は表示条件・実行条件として見たときの真偽、param は SQL に注入される文字列` +
      `${loop ? "。$val / $lno が使えるのは**パラメーターの式だけ**（ほかの口に書くと実行時に「無い項目」で落ちる）" : ""}`,
  };
}
