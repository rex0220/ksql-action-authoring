/**
 * kintone の項目定義とアプリの一覧（段階 3。`kact_fields` / `kact_apps`）。
 *
 * 約束（実装計画 5 章）:
 * - **GET だけ**（`src/kintone-rest.ts` が許す API 以外は送信前に止まる）。レコードは読まない
 * - 接続は**利用者が設定した接続のファイル**の profile だけ（`src/connections.ts`）。ファイルの場所と秘密の値は返さない
 * - 取った項目定義は作業フォルダーの `fields/<profile>/APP<番号>.json` に置く。**これはツールが作る控え**で、
 *   設定ファイルとは別物（取り直すと上書きする。設定ファイルの「上書きしない」約束はこちらには掛からない）
 * - 返すのは**項目の形だけ**（コード・型・ラベル・重複禁止・テーブルの親）。レコードの値は取らないので返しようがない
 */
import { readdirSync, renameSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ConnectionReport, Finding, ToolStatus } from "./core.ts";
import {
  authFor,
  loadConnections,
  pickProfile,
  ConnectionError,
  type ConnectionSet,
  type ProfileDef,
} from "./connections.ts";
import { createRestClient, NotAllowedError, RestError } from "./kintone-rest.ts";
import { KSQL_ACTION_PLUGIN_ID } from "./meta.ts";
import { resolveNewInWorkspace, workspaceDir } from "./workspace.ts";

/** 項目定義 1 つ分（kintone の form/fields の properties の値。知らないキーはそのまま持つ） */
export interface FieldProperty {
  type: string;
  code: string;
  label?: string;
  unique?: boolean;
  fields?: Record<string, FieldProperty>;
  [key: string]: unknown;
}

/**
 * AI に返す 1 項目 1 行の要約。**値の出どころ**も付ける（kSQL の `ksql_describe_app` を参考に。
 * SQL で書ける項目かが分かるようにするため）
 */
export interface FieldSummary {
  code: string;
  type: string;
  label: string;
  /** 「値の重複を禁止する」（`APPLY` の親のキーに使えるか。`KSQL1307` の判断に要る） */
  unique?: boolean;
  /** テーブルの子のとき、その親のコード */
  table?: string;
  /** **SQL で書けない**項目（自動の項目・計算・ルックアップのコピー先）。理由は `readOnly` */
  writable?: false;
  /** 書けない理由（`auto` = kintone が決める / `calc` = 計算 / `lookupCopy` = ルックアップのコピー先） */
  readOnly?: "auto" | "calc" | "lookupCopy";
  /** ルックアップの項目（キーを入れると関連する値が写る） */
  lookup?: true;
  /**
   * **選択肢の値**（`DROP_DOWN` / `RADIO_BUTTON` / `CHECK_BOX` / `MULTI_SELECT`。画面の並び順）。
   * SQL の条件（`WHERE 請求対象 = '対象'`）と計算式に書くのは**この値**。
   * 返さないと「選択肢は推測しない」決まりと、標準形が選択肢を SQL に書くことが噛み合わない
   * （2026-11-06 の試用 S4。`kact_try` にわざと外した値を渡してエラー文から読む、が唯一の手だった）
   */
  options?: string[];
}

/**
 * 設定ファイルの本文から、**SQL が触るアプリの項目定義**を集める（`アプリ番号 → properties`）。
 * 論理アプリ（`bindings`）の分と、渡された自アプリの分。控えが無いアプリは入らない（通信しない）。
 *
 * **`CheckOptions.fields`（自アプリの `properties`。キーは項目コード）とは形が違う。**
 * 検査・保存・実行計画の 3 か所が同じ形を作るように、ここに 1 つだけ置く
 * （2026-11-07 の試用 S4 の再実施。検査が自アプリの `properties` を
 * `createFieldsClient` に渡していて、選択肢の検査が黙って何もしていなかった）。
 */
export function appsFieldsFrom(text: string, alsoAppId = 0): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  const add = (id: number): void => {
    if (!Number.isSafeInteger(id) || id <= 0 || out[String(id)]) return;
    const hit = findFieldsFile(id);
    if (hit) out[String(id)] = hit.file.properties as unknown as Record<string, unknown>;
  };
  try {
    const parsed: unknown = JSON.parse(text);
    const bindings = parsed && typeof parsed === "object" ? (parsed as { bindings?: unknown }).bindings : undefined;
    if (Array.isArray(bindings)) for (const b of bindings) add(Number((b as { appId?: unknown })?.appId ?? 0));
  } catch {
    // 封筒が読めなければ自アプリの分だけ
  }
  add(alsoAppId);
  return out;
}

/** 控えが覚えているアプリの居場所（`appAreasFrom`／`CheckOptions.appAreas`） */
export interface AppArea {
  /** ドメイン。**領域を比べてよいかの鍵**（違うドメインの同じ番号は別のアプリ） */
  host: string;
  /** 控えを取った接続（findings の文に出す。判定には使わない） */
  profile: string;
  /** ゲストスペースの番号（`null` = 通常領域。`undefined` = 領域を記録する前の古い控え） */
  guestSpaceId?: number | null;
}

/**
 * 設定が触るアプリの**領域**（`アプリ番号 → { host, profile, guestSpaceId }`）を控えから集める。
 * **通信しない**。`guestSpaceId` が `undefined` の行は、領域を記録する前の古い控え。
 *
 * **突き合わせの鍵は `host`**（`profile` ではない）。接続のファイルの profile は
 * **ホストとゲストスペースの組**なので、同じドメインでもゲストスペースのアプリは必ず別の profile になる。
 * profile で比べると、**設定画面がいちばん止めたい形**（通常領域の画面からゲストスペースのアプリを選ぶ）が
 * まるごと「比べられない」に落ちた（2026-11-07 に 0.11.2 を実機で通して見つけた。
 * 4377〈dev・通常領域〉から 1687〈guest・ゲストスペース 15〉を参照しても warning にしかならなかった）。
 */
export function appAreasFrom(text: string, alsoAppId = 0): Record<string, AppArea> {
  const out: Record<string, AppArea> = {};
  const add = (id: number): void => {
    if (!Number.isSafeInteger(id) || id <= 0 || out[String(id)]) return;
    const hit = findFieldsFile(id);
    if (hit) out[String(id)] = { host: hit.file.host, profile: hit.file.profile, guestSpaceId: hit.file.guestSpaceId };
  };
  try {
    const parsed: unknown = JSON.parse(text);
    const obj = parsed && typeof parsed === "object" ? (parsed as { bindings?: unknown; logApp?: unknown }) : undefined;
    if (Array.isArray(obj?.bindings)) for (const b of obj.bindings) add(Number((b as { appId?: unknown })?.appId ?? 0));
    // ログアプリも領域を使う（`logApp.guestSpaceId` が控えと合っているか見る。`logAppFindings`）
    const logApp = obj?.logApp;
    if (logApp && typeof logApp === "object") add(Number((logApp as { appId?: unknown }).appId ?? 0));
  } catch {
    // 封筒が読めなければ自アプリの分だけ
  }
  add(alsoAppId);
  return out;
}

/**
 * 保存された設定（`setConfig` が入れたままのキーと値）の digest。
 * **取得した後に設定画面で直されたか**を比べる鍵（`source.storedDigest`）。
 * キーの並びに左右されないよう、キーで並べてから JSON にする。
 * **`revision` は比べない**: あれは「アプリの設定」全体の版で、項目を 1 つ直しただけでも変わる
 */
export function storedDigestOf(stored: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(stored).sort()) sorted[k] = String(stored[k]);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/** 一覧で集めるアプリの上限（大きなドメインで延々と読まない。超えたら「続きがある」と伝える） */
const MAX_APPS = 500;

/** kintone が値を決める項目（SQL の `SET` に書けない） */
const AUTO_TYPES = new Set([
  "RECORD_NUMBER",
  "CREATED_TIME",
  "UPDATED_TIME",
  "CREATOR",
  "MODIFIER",
  "STATUS",
  "STATUS_ASSIGNEE",
  "CATEGORY",
  "__ID__",
  "__REVISION__",
]);

/** `fields/<profile>/APP<番号>.json` の形 */
export interface FieldsFile {
  tool: "kact fields";
  fetchedAt: string;
  profile: string;
  host: string;
  appId: number;
  appName: string;
  revision: string;
  /** 動作テスト環境（保存して未反映）の定義か */
  preview: boolean;
  /**
   * 取ったときの**領域**（ゲストスペース ID。通常領域は `null`）。
   *
   * 業務アプリは**自アプリと同じ領域**だけ使える（仕様 §4.1。実行時の client は画面の API 領域を使うので、
   * 別領域を登録すると**設定は通るのに実行してはじめて失敗する**）。設定画面は保存前に
   * `checkBindingArea` で見るが、tools には同じ検査が無かった（2026-11-07 の Codex レビュー）。
   * 控えに持たせておけば、**通信せずに**自アプリと論理アプリの領域を突き合わせられる。
   * 古い控えには無いので、そのときは「確かめていない」と伝える。
   */
  guestSpaceId?: number | null;
  properties: Record<string, FieldProperty>;
}

export interface KintoneOptions {
  /** 接続のファイルの場所（MCP の設定項目か `.env` の `KACT_KINTONE_CONFIG`。**中身も場所も返さない**） */
  configFile?: string;
  /** `env:` と `passwordEnv` を引く環境変数（中核は process.env を読まない） */
  env?: NodeJS.ProcessEnv;
  /** 作業フォルダー（接続のファイルがこの中にあれば拒否する） */
  workspaceDir?: string;
  /** 試験が差し替える fetch */
  fetchImpl?: Parameters<typeof createRestClient>[1];
}

export interface FieldsResult {
  status: ToolStatus;
  profile?: string;
  host?: string;
  appId?: number;
  appName?: string;
  revision?: string;
  preview?: boolean;
  /** 控えを置いた作業フォルダーからの相対パス */
  path?: string;
  /** 項目の数（テーブルの子も含む） */
  count?: number;
  fields?: FieldSummary[];
  findings: Finding[];
  /** 利用者に伝える一言 */
  message?: string;
}

export interface AppsResult {
  status: ToolStatus;
  profile?: string;
  host?: string;
  apps?: Array<{ appId: number; name: string; spaceId?: number }>;
  findings: Finding[];
  message?: string;
}

/** 一覧 1 つ分（`panel.views[].viewId` に書く値は `id`） */
export interface ViewSummary {
  /** 一覧 ID（文字列。実行時に `event.viewId` と突き合わせる） */
  id: string;
  name: string;
  /** `LIST` / `CALENDAR` / `CUSTOM`（知らない種類はそのまま） */
  type: string;
  /** kintone の作りつけの一覧（`(すべて)`・`(作業者が自分)`）。ツールが足した行にも付く */
  builtin?: true;
}

export interface ViewsResult {
  status: ToolStatus;
  profile?: string;
  host?: string;
  appId?: number;
  revision?: string;
  preview?: boolean;
  views?: ViewSummary[];
  findings: Finding[];
  message?: string;
}

/**
 * 「(すべて)」の一覧の ID（kintone の作りつけ。**`views.json` には返らない**）。
 * 本体の設定画面（`ksql-action/src/config/views.ts` の `ALL_VIEW_ID`）と同じ値で、あちらが正本
 */
export const ALL_VIEW_ID = "20";

const fail = (code: string, message: string, status: ToolStatus = "failed"): { status: ToolStatus; findings: Finding[] } => ({
  status,
  findings: [{ level: "error", code, message }],
});

/** 接続の誤りを返りの形に（場所に関わるものは denied、profile の指定ちがいは invalid、ほかは failed） */
function fromConnectionError(e: unknown): { status: ToolStatus; findings: Finding[] } {
  if (e instanceof ConnectionError) {
    const status: ToolStatus = e.code === "inside-workspace" ? "denied" : e.code === "unknown-profile" || e.code === "profile-invalid" || e.code === "guest-mismatch" ? "invalid" : e.code === "connection-changed" ? "conflict" : "failed";
    return fail(`connection-${e.code}`, e.message, status);
  }
  if (e instanceof NotAllowedError) return fail("not-allowed", e.message, "denied");
  if (e instanceof RestError) return fail("kintone", e.message, "failed");
  return fail("kintone", e instanceof Error ? e.message : String(e), "failed");
}

/** 接続のファイルを読んで profile を選ぶ */
function connectionFor(profile: string | undefined, opt: KintoneOptions): { set: ConnectionSet; def: ProfileDef } {
  const env = opt.env ?? process.env;
  const dir = opt.workspaceDir ?? workspaceDir(env);
  const set = loadConnections(opt.configFile, { workspaceRoots: [dir], env });
  return { set, def: pickProfile(set, profile) };
}

/** 接続のファイルの警告（権限など）を findings に（パスと値は入らない） */
const connectionWarnings = (set: ConnectionSet): Finding[] => set.warnings.map((w) => ({ level: "warning" as const, code: "connection", message: w }));

/**
 * 接続の診断（`kact_status` が使う）。接続のファイルを読んで**使える profile の形だけ**を返す。
 * kintone には通信しない。**ファイルのパス・中身・秘密の値は返さない**（名前・profile 名・ホストまで）
 */
export function connectionReport(opt: KintoneOptions = {}): { report: ConnectionReport; findings: Finding[] } {
  if (!opt.configFile) {
    return {
      report: { configured: false },
      findings: [{ level: "info", code: "connection-not-configured", message: "kintone の接続のファイルが設定されていない（KACT_KINTONE_CONFIG）。kact_fields / kact_apps は使えない（設定ファイルの検査と保存は使える）" }],
    };
  }
  try {
    const env = opt.env ?? process.env;
    const dir = opt.workspaceDir ?? workspaceDir(env);
    const set = loadConnections(opt.configFile, { workspaceRoots: [dir], env });
    return {
      report: {
        configured: true,
        fileName: set.fileName,
        ...(set.defaultProfile !== undefined ? { defaultProfile: set.defaultProfile } : {}),
        profiles: [...set.profiles.values()].map((p) => ({
          profile: p.profile,
          host: p.host,
          guestSpaceId: p.guestSpaceId,
          auth: p.auth,
          tokenApps: p.tokenApps,
          tokenReady: p.tokenReady,
          userpassReady: p.userpassReady,
        })),
        ...(set.invalid.length ? { invalid: [...set.invalid] } : {}),
      },
      findings: connectionWarnings(set),
    };
  } catch (e) {
    const r = fromConnectionError(e);
    return { report: { configured: true }, findings: r.findings };
  }
}

/** ルックアップのコピー先（ほかの項目の `lookup.fieldMappings[].field`）を集める。テーブルの中も見る */
function lookupCopyTargets(properties: Record<string, FieldProperty>): Set<string> {
  const out = new Set<string>();
  const scan = (props: Record<string, FieldProperty>): void => {
    for (const p of Object.values(props)) {
      const lookup = p.lookup as { fieldMappings?: Array<{ field?: unknown }> } | undefined;
      for (const m of lookup?.fieldMappings ?? []) if (typeof m.field === "string") out.add(m.field);
      if (p.type === "SUBTABLE" && p.fields) scan(p.fields);
    }
  };
  scan(properties);
  return out;
}

/** 1 項目分の要約（値の出どころの印つき） */
function summarizeOne(code: string, p: FieldProperty, copyTargets: Set<string>, table?: string): FieldSummary {
  const type = String(p.type ?? "");
  const readOnly: FieldSummary["readOnly"] | undefined = AUTO_TYPES.has(type)
    ? "auto"
    : type === "CALC"
      ? "calc"
      : copyTargets.has(code)
        ? "lookupCopy"
        : undefined;
  return {
    code,
    type,
    label: String(p.label ?? ""),
    ...(p.unique ? { unique: true } : {}),
    ...(table ? { table } : {}),
    ...(p.lookup ? { lookup: true as const } : {}),
    ...(readOnly ? { writable: false as const, readOnly } : {}),
    ...(() => {
      const options = choiceOptions(p);
      return options.length > 0 ? { options } : {};
    })(),
  };
}

/** 選択系の項目の型（選択肢の値を SQL と計算式に書く） */
const CHOICE_TYPES = new Set(["DROP_DOWN", "RADIO_BUTTON", "CHECK_BOX", "MULTI_SELECT"]);

/**
 * 選択肢の値を**画面の並び順**（`index`）で返す。選択系でなければ空。
 * kintone の `options` は `{ 値: { label, index } }` の形。
 *
 * **`lang` を付けずに取っているので、ここで見えるのは「既定の名称」**（＝項目の設定画面の値）。
 * kintone の「言語ごとの表示名」を設定した項目では、`lang: "user"` で取ると
 * **キー自体が表示言語の名称に変わる**（`sample1` → `サンプル１`）。
 * **SQL に書くのは既定の名称のほう**なので、`lang` は付けない（プラグインが実行時に
 * 利用者の言語へ読み替える＝エンジン 3.91.0 の `optionNames: "canonical"`。本体の仕様 §8.6）。
 * 以前ここに「選択肢に別名は無い」と書いていたのは誤り（2026-11-07 に訂正）。
 */
function choiceOptions(p: FieldProperty): string[] {
  if (!CHOICE_TYPES.has(String(p.type ?? ""))) return [];
  const options = p.options;
  if (!options || typeof options !== "object") return [];
  const rows = Object.entries(options as Record<string, unknown>).map(([value, def]) => {
    const index = def && typeof def === "object" ? Number((def as { index?: unknown }).index) : NaN;
    return { value, index: Number.isFinite(index) ? index : Number.MAX_SAFE_INTEGER };
  });
  rows.sort((a, b) => (a.index - b.index) || a.value.localeCompare(b.value));
  return rows.map((r) => r.value);
}

/**
 * テーブルの子も含めて 1 項目 1 行に（値は無い）。**値の出どころ**も付ける
 * （kSQL の `ksql_describe_app` を参考に。SQL の `SET` に書ける項目かが分かるようにするため）
 */
export function summarizeFields(properties: Record<string, FieldProperty>): FieldSummary[] {
  const copyTargets = lookupCopyTargets(properties);
  const out: FieldSummary[] = [];
  for (const code of Object.keys(properties).sort()) {
    const p = properties[code]!;
    out.push(summarizeOne(code, p, copyTargets));
    if (p.type === "SUBTABLE" && p.fields) {
      for (const child of Object.keys(p.fields).sort()) out.push(summarizeOne(child, p.fields[child]!, copyTargets, code));
    }
  }
  return out;
}

/**
 * 控えの置き場所（作業フォルダーからの相対パス）。
 *
 * **動作テスト環境（`preview`）は別のファイル**にする（2026-11-07 の Codex レビュー）。
 * 同じ名前にしていたので、`kact_fields` を `preview: true` で呼ぶと
 * **運用環境の控えを黙って上書き**していた（中の `preview` の印だけが変わる）。
 * 設定画面が見るのは動作テスト環境なので、どちらも持てる形にする。
 */
export function fieldsPathFor(profile: string, appId: number, preview = false): string {
  return `fields/${profile}/APP${appId}${preview ? "-preview" : ""}.json`;
}

/** 控えを読む（無ければ undefined。壊れていても undefined） */
export function readFieldsFile(profile: string, appId: number, dir?: string, preview = false): FieldsFile | undefined {
  const base = dir ?? workspaceDir();
  const file = path.join(base, fieldsPathFor(profile, appId, preview));
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const f = parsed as FieldsFile;
    return f.properties && typeof f.properties === "object" ? f : undefined;
  } catch {
    return undefined;
  }
}

/**
 * そのアプリの控えを探す（profile が分からなくても使えるように `fields/<どれか>/APP<番号>.json` を見る）。
 *
 * **接続先が違えば、同じアプリ番号は普通に別のアプリ**なので、複数見つかったことを黙って
 * 握りつぶさない（2026-11-07 の Codex レビュー。それまでは `fetchedAt` が新しいものを黙って採る作りで、
 * 誤った項目定義で検査しても返りは `formulaCheck: fields` としか出なかった）。
 *
 * 選び方: **運用環境の控えを先に見て**、無ければ動作テスト環境。同じ段で複数あれば
 * 新しいものを採るが、**`others` にほかの候補を入れて呼び側が知らせられるようにする**。
 */
export function findFieldsFile(
  appId: number,
  dir?: string,
): { file: FieldsFile; path: string; others: string[] } | undefined {
  const base = dir ?? workspaceDir();
  const root = path.join(base, "fields");
  if (!existsSync(root)) return undefined;
  const found: Array<{ file: FieldsFile; path: string; preview: boolean }> = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const preview of [false, true]) {
        const f = readFieldsFile(entry.name, appId, base, preview);
        if (f) found.push({ file: f, path: fieldsPathFor(entry.name, appId, preview), preview });
      }
    }
  } catch {
    return undefined;
  }
  if (found.length === 0) return undefined;
  // 運用環境を優先し、その中で新しいもの（無ければ動作テスト環境で同じ選び方）
  const tier = found.some((f) => !f.preview) ? found.filter((f) => !f.preview) : found;
  tier.sort((a, b) => String(b.file.fetchedAt).localeCompare(String(a.file.fetchedAt)));
  const best = tier[0]!;
  return { file: best.file, path: best.path, others: found.filter((f) => f.path !== best.path).map((f) => f.path) };
}

/**
 * 項目定義を取る（`kact_fields`）。アプリの名前（`app`）と項目定義（`app/form/fields`）を GET で読み、
 * 控えを置いて要約を返す。`preview: true` は動作テスト環境（設定画面が見るのと同じ定義。API トークンでは読めないことがある）
 */
export async function fetchFields(input: { app: number; profile?: string; preview?: boolean }, opt: KintoneOptions = {}): Promise<FieldsResult> {
  if (!Number.isSafeInteger(input.app) || input.app <= 0) return { ...fail("input", "app はアプリの番号（正の整数）で渡す", "invalid") };
  let conn: { set: ConnectionSet; def: ProfileDef };
  try {
    conn = connectionFor(input.profile, opt);
  } catch (e) {
    return { ...fromConnectionError(e) };
  }
  const { set, def } = conn;
  const guest = def.guestSpaceId ?? undefined;
  let app: { name?: string } = {};
  let form: { properties?: Record<string, FieldProperty>; revision?: string } = {};
  try {
    const client = createRestClient(authFor(set, def, input.app), opt.fetchImpl);
    app = await client.get<{ name?: string }>("app", { id: input.app }, guest);
    form = await client.get<{ properties?: Record<string, FieldProperty>; revision?: string }>(
      input.preview ? "preview/app/form/fields" : "app/form/fields",
      { app: input.app },
      guest,
    );
  } catch (e) {
    return { ...fromConnectionError(e), profile: def.profile, host: def.host };
  }
  const properties = form.properties ?? {};
  const file: FieldsFile = {
    tool: "kact fields",
    fetchedAt: new Date().toISOString(),
    profile: def.profile,
    host: def.host,
    appId: input.app,
    appName: String(app.name ?? ""),
    revision: String(form.revision ?? ""),
    preview: !!input.preview,
    guestSpaceId: def.guestSpaceId ?? null,
    properties,
  };
  // 動作テスト環境は別のファイル（運用環境の控えを上書きしない）
  const rel = fieldsPathFor(def.profile, input.app, !!input.preview);
  let target: string;
  try {
    target = resolveNewInWorkspace(rel, opt.workspaceDir ?? workspaceDir(opt.env ?? process.env));
  } catch (e) {
    return { ...fail("workspace", e instanceof Error ? e.message : String(e), "denied"), profile: def.profile, host: def.host };
  }
  // 控えなので上書きしてよい（取り直し）。書いている途中で壊れないように、一時ファイルに書いてから置き換える
  const temp = `${target}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, target);
  } catch (e) {
    return { ...fail("write-failed", e instanceof Error ? e.message : String(e)), profile: def.profile, host: def.host };
  }
  const fields = summarizeFields(properties);
  return {
    status: "ok",
    profile: def.profile,
    host: def.host,
    appId: input.app,
    appName: file.appName,
    revision: file.revision,
    preview: file.preview,
    path: rel,
    count: fields.length,
    fields,
    findings: connectionWarnings(set),
    message: `項目定義を ${rel} に置いた（${fields.length} 項目）。SQL と計算式には**項目コード**を書く`,
  };
}

/** `app/views` が返す 1 件（知らないキーは読まない） */
interface RawView {
  id?: string;
  index?: string | number;
  name?: string;
  type?: string;
  builtinType?: string;
}

/**
 * 一覧の ID を取る（`kact_views`）。`panel.views[].viewId` に書く値を調べるためのもの。
 *
 * **「(すべて)」は `views.json` に返らない**ので、ツールが `viewId: "20"` の行を**末尾に足す**
 * （本体の設定画面 `ksql-action/src/config/views.ts` と同じ作り。あちらが正本）。
 * 一覧（`LIST`）だけでなくカレンダー・カスタマイズ一覧も返す（一覧パネルはそれらのヘッダーにも出る）。
 */
export async function listViews(input: { app: number; profile?: string; preview?: boolean }, opt: KintoneOptions = {}): Promise<ViewsResult> {
  if (!Number.isSafeInteger(input.app) || input.app <= 0) return { ...fail("input", "app はアプリの番号（正の整数）で渡す", "invalid") };
  let conn: { set: ConnectionSet; def: ProfileDef };
  try {
    conn = connectionFor(input.profile, opt);
  } catch (e) {
    return { ...fromConnectionError(e) };
  }
  const { set, def } = conn;
  let resp: { views?: Record<string, RawView>; revision?: string } = {};
  try {
    const client = createRestClient(authFor(set, def, input.app), opt.fetchImpl);
    resp = await client.get<{ views?: Record<string, RawView>; revision?: string }>(
      input.preview ? "preview/app/views" : "app/views",
      { app: input.app },
      def.guestSpaceId ?? undefined,
    );
  } catch (e) {
    const r = fromConnectionError(e);
    // 同じ名前の一覧があると kintone は設定を返さない（REST の「一覧の設定を取得する」の制限事項）。
    // 400 で返るので、名前の重複をまず疑ってもらう
    const hint: Finding[] =
      e instanceof RestError && e.status === 400
        ? [{ level: "info", code: "views-duplicate-name", message: "**同じ名前の一覧があると kintone は一覧の設定を返さない**（REST の制限）。アプリの一覧の名前が重なっていないか確かめる" }]
        : [];
    return { ...r, findings: [...r.findings, ...hint], profile: def.profile, host: def.host };
  }
  const raw = Object.values(resp.views ?? {});
  const items = raw
    .filter((v) => v.id !== undefined)
    .map((v) => ({ id: String(v.id), name: String(v.name ?? ""), type: String(v.type ?? ""), index: Number(v.index ?? 0), builtin: v.builtinType !== undefined }))
    .sort((a, b) => a.index - b.index);
  const views: ViewSummary[] = [];
  for (const v of items) if (v.id !== ALL_VIEW_ID) views.push({ id: v.id, name: v.name, type: v.type, ...(v.builtin ? { builtin: true as const } : {}) });
  // 「(すべて)」は API に返らないので足す（本体の設定画面も同じ。末尾に置く）
  views.push({ id: ALL_VIEW_ID, name: "(すべて)", type: "LIST", builtin: true });
  return {
    status: "ok",
    profile: def.profile,
    host: def.host,
    appId: input.app,
    revision: String(resp.revision ?? ""),
    preview: !!input.preview,
    views,
    findings: [
      ...connectionWarnings(set),
      {
        level: "info",
        code: "views-all-added",
        message: `kintone の作りつけの「(すべて)」（viewId ${ALL_VIEW_ID}）は API に返らないので、ツールが末尾に足した。${input.preview ? "" : "運用環境の一覧を読んだ（設定画面が見るのは動作テスト環境。未反映の一覧も要るなら preview: true）"}`,
      },
    ],
    message: `一覧 ${views.length} 件。panel.views の "*"（ほかの一覧すべて）の行だけで足りるなら足さない。どの一覧を別扱い（パネル / メニュー / 出さない）にするかは**利用者に確かめる**`,
  };
}

/**
 * アプリの一覧（`kact_apps`）。**ログイン名とパスワードの接続でだけ**使える
 * （API トークンはアプリごとの鍵なので、アプリの一覧は読めない）。
 * kintone は**1 回に 100 件まで**しか返さないので、**名前で絞る**（`name`。部分一致）か `offset` で続きを読む
 * （2026-10-28 の実機確認で、番号の大きいアプリが先頭 100 件に入らず見つからなかった）
 */
export async function listApps(input: { profile?: string; limit?: number; name?: string; offset?: number } = {}, opt: KintoneOptions = {}): Promise<AppsResult> {
  let conn: { set: ConnectionSet; def: ProfileDef };
  try {
    conn = connectionFor(input.profile, opt);
  } catch (e) {
    return { ...fromConnectionError(e) };
  }
  const { set, def } = conn;
  if (def.auth === "token") {
    return {
      status: "invalid",
      profile: def.profile,
      host: def.host,
      findings: [
        {
          level: "error",
          code: "token-cannot-list",
          message: `profile「${def.profile}」は API トークンの接続なので、アプリの一覧は読めない（トークンはアプリごとの鍵）。アプリの番号を利用者に聞いて kact_fields で確かめる。tokenMap にあるアプリ: ${def.tokenApps.length ? def.tokenApps.join(", ") : "なし"}`,
        },
      ],
    };
  }
  try {
    const client = createRestClient(authFor(set, def, 0), opt.fetchImpl);
    const name = input.name?.trim();
    // kintone は 1 回に 100 件まで。kSQL の SHOW APPS と同じく**こちらで続きを読んで集める**（AI に offset を回させない）。
    // 大きなドメインで延々と読まないように、取る件数の上限（max）と往復の回数を決めておく
    const max = Math.min(Math.max(input.limit ?? MAX_APPS, 1), MAX_APPS);
    const page = 100;
    const apps: Array<{ appId: number; name: string; spaceId?: number }> = [];
    let offset = Math.max(input.offset ?? 0, 0);
    let more = false;
    for (let round = 0; round < Math.ceil(MAX_APPS / page); round += 1) {
      const r = await client.get<{ apps?: Array<{ appId?: string; name?: string; spaceId?: string | null }> }>(
        "apps",
        { limit: page, ...(offset ? { offset } : {}), ...(name ? { name } : {}) },
        def.guestSpaceId ?? undefined,
      );
      const got = r.apps ?? [];
      for (const a of got) {
        apps.push({ appId: Number(a.appId ?? 0), name: String(a.name ?? ""), ...(a.spaceId ? { spaceId: Number(a.spaceId) } : {}) });
      }
      offset += got.length;
      if (got.length < page) break;
      if (apps.length >= max) {
        more = true;
        break;
      }
    }
    if (apps.length > max) apps.length = max;
    return {
      status: "ok",
      profile: def.profile,
      host: def.host,
      apps,
      findings: more
        ? [
            ...connectionWarnings(set),
            { level: "info" as const, code: "apps-more", message: `${max} 件で切った（まだ続きがある）。name で名前を絞るか、offset ${offset} で続きを読む` },
          ]
        : connectionWarnings(set),
      message: `${apps.length} 件${name ? `（名前に「${name}」を含む）` : ""}${more ? "・まだ続きがある" : ""}。どのアプリを使うかは**利用者に確かめる**`,
    };
  } catch (e) {
    return { ...fromConnectionError(e), profile: def.profile, host: def.host };
  }
}

/**
 * アプリに入っている **kSQL アクションの設定**を kintone から直に読む（**APIラボ**）。
 *
 * `GET /k/v1/app/plugin/config.json`（動作テスト環境は `preview/…`）。返るのは
 * **`setConfig` が入れたままのキーと値**なので、ほどくのは**本体の `readStoredConfig`**（API 版 10）。
 * ほどき方を tools に写さない（分割の仕方・`compress` の別・旧形式が本物とずれる）。
 *
 * **プラグイン ID は固定**（引数で受けない）。受けると**他社プラグインの設定を読める口**になり、
 * 他社の設定には鍵が入っていることがある。
 *
 * **APIラボは「テスト環境だけでの利用を推奨」**（サイボウズの注記）なので、
 * ここが使えないことを**普通のこと**として扱う。呼び出し側は
 * 「設定画面で［設定をダウンロード］してもらう」道に落とす。
 */
export async function fetchPluginConfig(
  input: { app: number; profile?: string; preview?: boolean },
  opt: KintoneOptions = {},
): Promise<{ status: ToolStatus; profile?: string; host?: string; guestSpaceId?: number | null; preview?: boolean; appName?: string; stored?: Record<string, string>; revision?: string; findings: Finding[] }> {
  if (!Number.isSafeInteger(input.app) || input.app <= 0) return fail("input", "app はアプリの番号（正の整数）で渡す", "invalid");
  let conn: { set: ConnectionSet; def: ProfileDef };
  try {
    conn = connectionFor(input.profile, opt);
  } catch (e) {
    return fromConnectionError(e);
  }
  const { set, def } = conn;
  try {
    const client = createRestClient(authFor(set, def, input.app), opt.fetchImpl);
    // アプリの名前も取る（封筒に入れ、**どのアプリから読んだかを利用者に見せる**ため。取り違えの歯止め）
    const app = await client.get<{ name?: string }>("app", { id: input.app }, def.guestSpaceId ?? undefined);
    const r = await client.get<{ config?: Record<string, string>; revision?: unknown }>(
      // 既定は**動作テスト環境**（設定画面が編集しているのはこちら。`kact_fields` の preview と同じ考え）
      input.preview === false ? "app/plugin/config" : "preview/app/plugin/config",
      { app: input.app, id: KSQL_ACTION_PLUGIN_ID },
      def.guestSpaceId ?? undefined,
    );
    const stored = r.config ?? {};
    if (Object.keys(stored).length === 0) {
      return {
        status: "invalid",
        profile: def.profile,
        host: def.host,
        findings: [{
          level: "error",
          code: "plugin-not-added",
          message: `アプリ ${input.app} に kSQL アクションの設定がありません（プラグインを追加して、設定を 1 度保存してもらってください）`,
        }],
      };
    }
    return { status: "ok", profile: def.profile, host: def.host, guestSpaceId: def.guestSpaceId ?? null, preview: input.preview !== false, appName: String(app.name ?? ""), stored, revision: String(r.revision ?? ""), findings: [] };
  } catch (e) {
    const r = fromConnectionError(e);
    return {
      ...r,
      profile: def.profile,
      host: def.host,
      findings: [
        ...r.findings,
        {
          level: "warning",
          code: "api-lab",
          message:
            "この口は**APIラボ**（検討中の新機能）です。ドメインで有効になっていないと使えません"
            + "（アップデートオプションの「検討中の新機能」）。"
            + "**使えないときは、これまでどおり設定画面の［設定をダウンロード］→ `kact_pull`（`from`）で進めてください**",
        },
      ],
    };
  }
}
