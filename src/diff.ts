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
const ACTION_SCALARS = [
  "enabled", "name", "description", "type", "onList", "panelSection", "confirm", "writeLimit",
  // イベント起動のときログに何を残すか（失敗だけ / すべて / 残さない）。漏れていた（2026-11-07 の Codex レビュー）
  "eventLog",
  "refreshPrompt", "selectionMode", "listOnError", "perRecordLock", "prevRecord", "allowAll", "loop", "loopOnError",
  // 多言語の列（§8.5。2026-11-06）。無い → 入れた も差として出る
  "name_ja", "name_en", "name_zh", "description_ja", "description_en", "description_zh",
];
/** アクションの、行の差分で見る文（SQL と計算式） */
const ACTION_TEXTS = ["sql", "showCond", "execCond", "execNgMessage", "resultMessage", "groupFormula"];
/** アクションの、まとめて比べる配列 */
// targetViews は 2026-10-31 に廃止（一覧ごとの出す区分 = 共通設定の panel.views）
const ACTION_LISTS = ["placements", "params", "inputs", "allowed"];

const show = (v: unknown): string => (v === undefined ? "（無し）" : typeof v === "string" ? (v === "" ? "（空）" : v) : JSON.stringify(v));

/**
 * `params[]` / `inputs[]` の **`enabled: true` は「省略」と同じ**なので、比べる前に落とす。
 *
 * `enabled` は 2026-11-05 に足したキーで、保存済みの設定には無く本体の `migrateConfig` が `true` を入れる。
 * ツールは**わざと埋めない**（埋めると古い版の zip が `unknown key` で断る。`save.ts`）ので、
 * ツールが書いたファイルと設定画面を一往復したファイルを比べると、**中身は同じなのに差分が出ていた**
 * （2026-11-06 の試用 S3 の再実施）。`enabled: false` は意味があるので残す。
 */
function dropDefaultEnabled(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  return v.map((x) => {
    if (!x || typeof x !== "object" || Array.isArray(x)) return x;
    const o = x as Record<string, unknown>;
    if (o.enabled !== true) return o;
    const { enabled: _drop, ...rest } = o;
    return rest;
  });
}

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

const objList = (v: unknown): Obj[] => (Array.isArray(v) ? v : []).filter((x): x is Obj => !!x && typeof x === "object");
/** 区分なしは `""` で持つので、そのままだと空に見える */
const sectionName = (s: unknown): string => (String(s ?? "") === "" ? "（区分なし）" : String(s));
const joinOrNone = (list: string[]): string => (list.length > 0 ? list.join(", ") : "なし");

/** 画面 × 区分 の 1 行を人が読む形に */
function viewText(v: Obj | undefined): string {
  if (!v) return "（無し）";
  const parts: string[] = [];
  if (v.enabled === false) parts.push("無効");
  parts.push(`パネル: ${joinOrNone(Array.isArray(v.sections) ? (v.sections as unknown[]).map(sectionName) : [])}`);
  parts.push(`メニュー: ${joinOrNone(Array.isArray(v.menus) ? (v.menus as unknown[]).map(sectionName) : [])}`);
  if (v.open === true) parts.push("開いて出す");
  return parts.join(" / ");
}

/**
 * パネル・区分（`panel`）の差。
 *
 * **ここを出さないと、古い控えをそのまま取り込んで区分が消えたことに気づけない**
 * （取り込みは全置換。`panel` を読むツールは無いので、差分が唯一の手がかり。2026-11-06 の試用 S3）。
 * 区分は名前の列で、画面ごとの出し方は**一覧 ID で対応付けて**変わった行だけ出す。
 */
function panelDiffs(a: Obj | undefined, b: Obj | undefined, out: string[]): void {
  const pa = (a ?? {}) as Obj;
  const pb = (b ?? {}) as Obj;
  scalarDiffs(pa, pb, ["title", "sectionColumns", "buttonWidth", "buttonLogLink"], out, "共通設定 / パネル・区分 / ");
  const names = (p: Obj): string[] =>
    objList(p.sections).map((s) => `${sectionName(s.name)}${s.enabled === false ? "（無効）" : ""}`);
  if (!same(pa.sections, pb.sections)) {
    out.push(`共通設定 / 区分: ${joinOrNone(names(pa))} → ${joinOrNone(names(pb))}`);
  }
  const rows = (p: Obj): Map<string, Obj> => new Map(objList(p.views).map((v) => [String(v.viewId ?? ""), v]));
  const ra = rows(pa);
  const rb = rows(pb);
  for (const id of new Set([...ra.keys(), ...rb.keys()])) {
    const va = ra.get(id);
    const vb = rb.get(id);
    if (same(va, vb)) continue;
    const label = id === "detail" ? "詳細画面" : id === "*" ? "ほかの一覧すべて" : `一覧 ${id}`;
    out.push(`共通設定 / 画面ごとの出し方 / ${label}: ${viewText(va)} → ${viewText(vb)}`);
  }
}

/**
 * 共通の文の差（§8.4）。**コードごと**に比べる（並べ替えただけでは差にしない）。
 * `panel` と同じ扱いで、ツールから読めない設定を「黙って消える」ままにしないため（§3.1）
 */
function messageDiffs(a: unknown, b: unknown, out: string[]): void {
  const map = (v: unknown): Map<string, Obj> => new Map(objList(v).map((m) => [String(m.code ?? ""), m]));
  const ma = map(a);
  const mb = map(b);
  const text = (m: Obj | undefined): string => {
    if (!m) return "（無し）";
    const langs = ["ja", "en", "zh"].map((l) => ({ l, v: String(m[`text_${l}`] ?? "").trim() })).filter(({ v }) => v !== "");
    return `${String(m.text ?? "")}${langs.length > 0 ? `（${langs.map(({ l, v }) => `${l}: ${v}`).join(" / ")}）` : ""}`;
  };
  for (const code of new Set([...ma.keys(), ...mb.keys()])) {
    const va = ma.get(code);
    const vb = mb.get(code);
    if (same(va, vb)) continue;
    out.push(`共通設定 / メッセージ / ${code}: ${text(va)} → ${text(vb)}`);
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
  /**
   * **コードが変わったことを必ず出す**（2026-11-07 の試用 S8）。
   *
   * `kact_diff` はコードで突き合わせるので、対になった 2 つのコードは必ず同じ＝この行は出ない。
   * 出るのは **`kact_update_action` の `replaceCode` で改名したとき**だけ。
   * コードは**ロックキーとログの名前**なので、設定の中でいちばん重い変更なのに、
   * `ACTION_SCALARS` に無いせいで `changes` から落ちていた
   * （改名したのに `name` の変更しか出ず、利用者に見せる物として足りない）。
   */
  if (String(before.code ?? "") !== String(after.code ?? "")) {
    out.push(`${at}code: ${show(before.code)} → ${show(after.code)}（**ロックキーとログの名前が変わります**。過去のログとの対応は切れます）`);
  }
  scalarDiffs(before, after, ACTION_SCALARS, out, at);
  for (const k of ACTION_LISTS) {
    const b = k === "params" || k === "inputs" ? dropDefaultEnabled(before[k]) : before[k];
    const a = k === "params" || k === "inputs" ? dropDefaultEnabled(after[k]) : after[k];
    if (!same(b, a)) out.push(`${at}${k}: ${show(before[k])} → ${show(after[k])}`);
  }
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
  scalarDiffs(a, b, ["configVersion", "timezone", "progressStyle", "pluginComment", "pluginDescription"], out, "共通設定 / ");
  if (!same(a.bindings, b.bindings)) out.push(`共通設定 / 論理アプリ: ${show(a.bindings)} → ${show(b.bindings)}`);
  /**
   * ログアプリ。**「あり → あり」だけでは、記録先が変わっても分からなかった**
   * （2026-11-07 の Codex レビュー）。無しとの出入りはそのまま、両方あるときは**項目ごとに**比べる。
   * 秘密の値は入らない（アプリ番号・領域・実行環境名・一覧・パネルの見せ方だけ）
   */
  if (!same(a.logApp, b.logApp)) {
    const la = a.logApp as Obj | undefined;
    const lb = b.logApp as Obj | undefined;
    if (!la || !lb) out.push(`共通設定 / ログアプリ: ${la ? "あり" : "無し"} → ${lb ? "あり" : "無し"}`);
    else {
      scalarDiffs(la, lb, ["appId", "profile", "guestSpaceId", "viewId", "panelLog", "panelLogOpen", "panelLogCount", "panelLogRefreshMin"], out, "共通設定 / ログアプリ / ");
    }
  }
  // loopMax / runMax は 2026-11-05 にループと一緒に足した項目。漏れていた（2026-11-06 の試用 S3）
  scalarDiffs(a.limits as Obj | undefined, b.limits as Obj | undefined, ["readMax", "tempTableMax", "tempTotalMax", "timeoutMin", "apiTimeoutSec", "listBulkMax", "applySubtableMax", "loopMax", "runMax"], out, "共通設定 / 制限 / ");
  panelDiffs(a.panel as Obj | undefined, b.panel as Obj | undefined, out);
  messageDiffs(a.messages, b.messages, out);

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
