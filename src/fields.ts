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

/** AI に返す 1 項目 1 行の要約 */
export interface FieldSummary {
  code: string;
  type: string;
  label: string;
  /** 「値の重複を禁止する」（`APPLY` の親のキーに使えるか。`KSQL1307` の判断に要る） */
  unique?: boolean;
  /** テーブルの子のとき、その親のコード */
  table?: string;
}

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

/** テーブルの子も含めて 1 項目 1 行に（値は無い） */
export function summarizeFields(properties: Record<string, FieldProperty>): FieldSummary[] {
  const out: FieldSummary[] = [];
  for (const code of Object.keys(properties).sort()) {
    const p = properties[code]!;
    out.push({ code, type: String(p.type ?? ""), label: String(p.label ?? ""), ...(p.unique ? { unique: true } : {}) });
    if (p.type === "SUBTABLE" && p.fields) {
      for (const child of Object.keys(p.fields).sort()) {
        const c = p.fields[child]!;
        out.push({ code: child, type: String(c.type ?? ""), label: String(c.label ?? ""), ...(c.unique ? { unique: true } : {}), table: code });
      }
    }
  }
  return out;
}

/** 控えの置き場所（作業フォルダーからの相対パス） */
export function fieldsPathFor(profile: string, appId: number): string {
  return `fields/${profile}/APP${appId}.json`;
}

/** 控えを読む（無ければ undefined。壊れていても undefined） */
export function readFieldsFile(profile: string, appId: number, dir?: string): FieldsFile | undefined {
  const base = dir ?? workspaceDir();
  const file = path.join(base, fieldsPathFor(profile, appId));
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
 * 複数あれば**新しいもの**を使う。`kact_check` と保存のツールは、これがあれば計算式を項目コードまで検査する
 */
export function findFieldsFile(appId: number, dir?: string): { file: FieldsFile; path: string } | undefined {
  const base = dir ?? workspaceDir();
  const root = path.join(base, "fields");
  if (!existsSync(root)) return undefined;
  let best: { file: FieldsFile; path: string } | undefined;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const found = readFieldsFile(entry.name, appId, base);
      if (!found) continue;
      if (!best || String(found.fetchedAt) > String(best.file.fetchedAt)) best = { file: found, path: fieldsPathFor(entry.name, appId) };
    }
  } catch {
    return undefined;
  }
  return best;
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
    properties,
  };
  const rel = fieldsPathFor(def.profile, input.app);
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

/**
 * アプリの一覧（`kact_apps`）。**ログイン名とパスワードの接続でだけ**使える
 * （API トークンはアプリごとの鍵なので、アプリの一覧は読めない）
 */
export async function listApps(input: { profile?: string; limit?: number } = {}, opt: KintoneOptions = {}): Promise<AppsResult> {
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
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
    const r = await client.get<{ apps?: Array<{ appId?: string; name?: string; spaceId?: string | null }> }>("apps", { limit }, def.guestSpaceId ?? undefined);
    const apps = (r.apps ?? []).map((a) => ({
      appId: Number(a.appId ?? 0),
      name: String(a.name ?? ""),
      ...(a.spaceId ? { spaceId: Number(a.spaceId) } : {}),
    }));
    return {
      status: "ok",
      profile: def.profile,
      host: def.host,
      apps,
      findings: connectionWarnings(set),
      message: `${apps.length} 件（上限 ${limit} 件）。どのアプリを使うかは**利用者に確かめる**`,
    };
  } catch (e) {
    return { ...fromConnectionError(e), profile: def.profile, host: def.host };
  }
}
