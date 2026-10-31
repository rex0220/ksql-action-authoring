/**
 * 2 つの設定ファイルの差（`kact_diff`）。取り込む前に人が見るためのもの。
 * - アクションは**コードで対応付ける**（並びが変わっただけなら「順番」として出す）
 * - SQL と計算式は**行の差分**（変わった行だけ。全文は出さない）
 * - そのほかの値は `古い → 新しい`
 * 作りは印刷屋の `tools/src/commands/diff.ts` と同じ考え（あちらが正本）。
 */
import { formatDiff, lineDiff } from "./line-diff.ts";

type Obj = Record<string, unknown>;

const ENVELOPE_KEYS = ["appId", "appName", "PluginVersion"];
/** アクションの、そのまま比べる値 */
const ACTION_SCALARS = ["enabled", "name", "description", "type", "onList", "panelSection", "confirm", "writeLimit", "refreshPrompt", "selectionMode", "listOnError", "perRecordLock", "prevRecord", "allowAll"];
/** アクションの、行の差分で見る文（SQL と計算式） */
const ACTION_TEXTS = ["sql", "showCond", "execCond", "execNgMessage", "resultMessage", "groupFormula"];
/** アクションの、まとめて比べる配列 */
// targetViews は 2026-10-31 に廃止（一覧ごとの出す区分 = 共通設定の panel.views）
const ACTION_LISTS = ["placements", "params", "inputs", "allowed"];

const show = (v: unknown): string => (v === undefined ? "（無し）" : typeof v === "string" ? (v === "" ? "（空）" : v) : JSON.stringify(v));

/**
 * 値を比べるための文字列（**キーの順は無視する**）。
 * 既定値で埋め直すとキーの順が変わるので、そのままの `JSON.stringify` では
 * 中身が同じ `params` / `inputs` が「変わった」ように出ていた（2026-10-28 の試用 S4）。
 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

export function bodyOf(envelope: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(envelope)) if (!["date", "pluginName", "pluginID", "PluginVersion", "appId", "appName"].includes(k)) out[k] = v;
  return out;
}

function scalarDiffs(a: Obj | undefined, b: Obj | undefined, keys: string[], out: string[], prefix: string): void {
  for (const k of keys) {
    if (!same(a?.[k], b?.[k])) out.push(`${prefix}${k}: ${show(a?.[k])} → ${show(b?.[k])}`);
  }
}

/** 封筒 2 つを比べて、人が読む差分の文を返す（同じなら空文字） */
/**
 * アクション 1 つ分の差（`kact_diff` と `kact_update_action` が使う）。
 * `kact_update_action` は同じファイルを書き替えるので、直す前の控えが残らない
 * （`kact_diff` の `before` に渡せるファイルが無い）。だから更新した側が差を返す（2026-10-28 の試用 S3）。
 */
export function actionDiff(code: string, before: Obj | undefined, after: Obj | undefined): string[] {
  const out: string[] = [];
  if (!before) {
    out.push(`アクション ${code}: 追加（${show(after?.type)} / ${show(after?.name)}）`);
    return out;
  }
  if (!after) {
    out.push(`アクション ${code}: 削除`);
    return out;
  }
  const at = `アクション ${code} / `;
  scalarDiffs(before, after, ACTION_SCALARS, out, at);
  for (const k of ACTION_LISTS) if (!same(before[k], after[k])) out.push(`${at}${k}: ${show(before[k])} → ${show(after[k])}`);
  for (const k of ACTION_TEXTS) {
    const s1 = String(before[k] ?? "");
    const s2 = String(after[k] ?? "");
    if (s1 === s2) continue;
    out.push(`${at}${k}:`);
    out.push(formatDiff(lineDiff(s1, s2)));
  }
  return out;
}

export function diffConfigs(before: Obj, after: Obj): string {
  const out: string[] = [];
  for (const k of ENVELOPE_KEYS) if (!same(before[k], after[k])) out.push(`封筒 ${k}: ${show(before[k])} → ${show(after[k])}`);

  const a = bodyOf(before);
  const b = bodyOf(after);
  scalarDiffs(a, b, ["configVersion", "timezone", "pluginComment", "pluginDescription"], out, "共通設定 / ");
  if (!same(a.bindings, b.bindings)) out.push(`共通設定 / 論理アプリ: ${show(a.bindings)} → ${show(b.bindings)}`);
  if (!same(a.logApp, b.logApp)) out.push(`共通設定 / ログアプリ: ${a.logApp ? "あり" : "無し"} → ${b.logApp ? "あり" : "無し"}`);
  scalarDiffs(a.limits as Obj | undefined, b.limits as Obj | undefined, ["readMax", "tempTableMax", "tempTotalMax", "timeoutMin", "apiTimeoutSec", "listBulkMax", "applySubtableMax"], out, "共通設定 / 制限 / ");

  const listA = (Array.isArray(a.actions) ? a.actions : []) as Obj[];
  const listB = (Array.isArray(b.actions) ? b.actions : []) as Obj[];
  const key = (r: Obj, i: number): string => String(r.code ?? `#${i + 1}`);
  const mapA = new Map(listA.map((r, i) => [key(r, i), r]));
  const mapB = new Map(listB.map((r, i) => [key(r, i), r]));
  for (const code of new Set([...mapA.keys(), ...mapB.keys()])) {
    out.push(...actionDiff(code, mapA.get(code), mapB.get(code)));
  }
  // 並び（コードの順）
  const orderA = listA.map((r, i) => key(r, i)).filter((c) => mapB.has(c));
  const orderB = listB.map((r, i) => key(r, i)).filter((c) => mapA.has(c));
  if (!same(orderA, orderB)) out.push(`アクションの並び（ボタンを出す順）: ${orderA.join(" → ")} から ${orderB.join(" → ")} へ`);
  return out.join("\n");
}
