/**
 * kSQL アクションの計算式エンジン（KintoneFormulaKact.min.js）と authoring API（ksql-action-authoring-api.js）を Node で動かす。
 * どちらも**利用者のkSQL アクション zip から読む**（plugin-zip.ts。tools は配らない）。
 * 段階 0 の work/authoring-spike/engine.mjs が元（docs/authoring-plan.md 11 章、12.2、12.9 の 9）。
 *   - happy-dom の window / document をグローバルに置く（ESC_HTML などが document を使う。API の bundle は window にグローバルを置く）
 *   - kintone / cybozu / rex0220_users_info3 は副作用の無いスタブ。kintone.api は呼ばない（reject）。kintone.api.url は setContext の URL から組む
 *   - 読む順はkSQL アクションの manifest と同じ: moment（vendor/）→ moment-timezone → bignumber → decimal（Ver.9 から。zip にあれば）→ KintoneFormulaKact → authoring API
 *   - 読み込んでよいかの照合（1.1.0。Takashi 2026-10-08「pluginid のチェックのみで OK」、docs/authoring-plan.md 12.18）: 外側の zip の PUBKEY から出る
 *     プラグイン ID がkSQL アクションのもの（meta.ts の KSQL_ACTION_PLUGIN_ID）でなければ**実行せずに止める**。SIGNATURE は検証しない（本物の zip の PUBKEY を写した zip も通る）。
 *     manifest の version が Ver.6 以上の整数か、authoring API があるか。実行した後に API の apiVersion（SUPPORTED_API_VERSIONS）と pluginVersion、tools が使うキーの型。
 *     1.0.0 までは 4 ファイルの SHA-256 を既知のリリースの組と照合していた（1-10 レビュー BLOCKER 2）。tools の版はkSQL アクションの版と独立（2026-10-06 Takashi）
 *   - 開発中に隣の ksql-action の prod/ から読む経路は、**ソースから動かしていて（mode dev）かつ KACT_ALLOW_DEV_PLUGIN=1 のときだけ**。
 *     公開ビルド（mode build）では zip 以外から読まない（再レビュー BLOCKER 1: 利用者の node_modules に置いたファイルを実行しない）
 * zip の中のコードはこのプロセス（Node を起動した OS ユーザーと同じ権限）で動く。sandbox ではない。
 * 1 プロセスに 1 回だけ読む（グローバルを使うため）。読み込んだ後に別の読み込み元（zip は実体のパス・大きさ・更新日時、dev はフォルダーの実体のパス）を
 * 渡されたら止める（zip-changed。前は黙って最初のエンジンを返していた。kact MCP は作業フォルダーごとに zip を選べる。B1 の Codex 再レビュー MAJOR 2、3 回目 MINOR 3）。
 * zip のコードを動かし始めた後（グローバルの DOM・kintone のスタブを置いた後）に読み込みが失敗したら、このプロセスでは読み込み直さない
 * （restart-required。失敗した zip のグローバルが残ったまま次の zip を読むと混ざる。B1 の Codex 3 回目 MAJOR 1）。その前の失敗（無い・読めない・別のプラグイン・版）はやり直せる。
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import type { KsqlActionAuthoringApi } from "ksql-action/src/authoring/api.ts";
import { MOMENT_FILE } from "./paths.ts";
import { API_ENTRY, BIGNUMBER_ENTRY, DECIMAL_ENTRY, ENGINE_ENTRY, MANIFEST_ENTRY, MOMENT_TZ_ENTRY, PluginZipError, readPluginZip, sha256Hex, type PluginSources, type PluginZipErrorInfo } from "./plugin-zip.ts";
import { isSupportedPluginVersion, MIN_PLUGIN_VERSION, KSQL_ACTION_PLUGIN_ID, requiredApiFor, SUPPORTED_API_VERSIONS, toolsMeta } from "./meta.ts";

/** 計算式のインスタンス（ksql-action の config/libs.ts の KintoneFormula と同じ形） */
export interface FormulaInstance {
  funs: Record<string, unknown>;
  usedFields(init?: Record<string, unknown>): Record<string, unknown>;
  dq(expression: string): unknown;
  initTableInfo?(ptcode: string): void;
}

export type FormulaCtor = new (name: string, pp: unknown, record: unknown, fieldCheck: boolean, strict?: boolean) => FormulaInstance;

export interface LoginUser {
  id: string;
  code: string;
  name: string;
  email: string;
  language: string;
}

export interface KintoneContext {
  baseUrl: string;
  appId: number;
  loginUser: LoginUser;
}

export interface EngineSource {
  kind: "zip" | "dev";
  from: string;
  pluginVersion: string;
  engineSha256: string;
  apiSha256?: string;
  /** decimal.js（kSQL アクション Ver.9 から。無い zip は undefined） */
  decimalSha256?: string;
  /** プラグイン ID（zip の PUBKEY から。kSQL アクションのものでなければ読み込まない。pull が使う。開発中の ksql-action から読んだときは無い） */
  pluginId?: string;
}

export interface Engine {
  window: Record<string, unknown>;
  Ctor: FormulaCtor;
  /** kSQL アクションの authoring API（設定画面・帳票のコードと kit） */
  api: KsqlActionAuthoringApi;
  source: EngineSource;
  /** 読み込み時の注意（既知でない中身を許して続けたなど） */
  warnings: string[];
  setContext(ctx: Partial<KintoneContext>): void;
  /**
   * ユーザー情報の表（rex0220_users_info3.data。UINFO / OINFO / GINFO / OUSERS / GUSERS が読む）を差し替える（tools 2.3.0。お試しアプリの既定のテストデータ。
   * 評価の子プロセスの仕事ごとに。ksql-action の docs/authoring-try-plan.md 4.1）。ログインユーザーは setContext の loginUser
   */
  setUsers(table: unknown): void;
  /** 設定画面と同じ検証用のインスタンス（createFormula） */
  checker(pp: unknown, crec: unknown): FormulaInstance;
  /** デスクトップと同じ実行用のインスタンス（newFormula） */
  runner(pp: unknown, record: unknown): FormulaInstance;
  functionNames(): string[];
}

export interface LoadEngineOptions {
  /**
   * kSQL アクションの zip。中核は環境変数を読まない（段階 0-2。CLI は .env / OS の環境変数の KACT_PLUGIN_ZIP を env.ts の pluginZipPath で
   * 決めて渡す。kact MCP は設定項目から渡す）
   */
  pluginZip?: string;
  /** 開発中（mode dev）の読み込み元（隣の ksql-action の prod/）。CLI は環境変数 KACT_ALLOW_DEV_PLUGIN=1 のときだけ dev-paths.ts の ksqlActionProdDir で決めて渡す */
  devPluginDir?: string;
  /** テスト用。省略時は toolsMeta().mode（ソースから動かすと dev、ビルドした bundle は build） */
  mode?: "build" | "dev";
}

/** 接続先が分からないときの APP_URL などの元（実在しないテナント） */
export const DEFAULT_CONTEXT_BASE_URL = "https://example.cybozu.com";
const DEFAULT_USER: LoginUser = { id: "1", code: "authoring", name: "authoring", email: "", language: "ja" };

let loaded: Engine | null = null;
/** 読み込んだ元（zip は実体のパス・大きさ・更新日時、dev はフォルダーの実体のパス） */
let loadedStamp: SourceStamp | null = null;
/** 読み込みの途中（同時の呼び出しは、これが終わるのを待ってから照合する） */
let loading: Promise<Engine> | null = null;
/** zip のコードを動かし始めた後の読み込みの失敗（このプロセスでは読み込み直さない） */
let poisoned: { code: string; info: PluginZipErrorInfo } | null = null;

interface SourceStamp {
  kind: "zip" | "dev";
  real: string;
  size?: number;
  mtimeMs?: number;
}

/** 呼び出しが求める読み込み元（resolvePluginSources と同じ順: zip、無ければ dev）。どちらも渡さなければ undefined、在るはずのものが無ければ null */
function requestedStamp(opt: LoadEngineOptions): SourceStamp | null | undefined {
  try {
    if (opt.pluginZip) {
      const real = realpathSync(opt.pluginZip);
      const st = statSync(real);
      return { kind: "zip", real, size: st.size, mtimeMs: st.mtimeMs };
    }
    if (opt.devPluginDir) return { kind: "dev", real: realpathSync(opt.devPluginDir) };
    return undefined;
  } catch {
    return null;
  }
}

const sameStamp = (a: SourceStamp | null | undefined, b: SourceStamp | null): boolean =>
  !!a && !!b && a.kind === b.kind && a.real === b.real && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** 読み込み元を決める: zip（引数 → 環境変数）。開発中（mode dev + KACT_ALLOW_DEV_PLUGIN=1）だけ隣の ksql-action の prod/ */
export function resolvePluginSources(opt: LoadEngineOptions = {}, mode: "build" | "dev" = opt.mode ?? toolsMeta().mode): PluginSources & { kind: "zip" | "dev" } {
  const zip = opt.pluginZip;
  if (zip) {
    if (!existsSync(zip)) throw new PluginZipError(`kSQL アクションの zip が無い: ${zip}（.env の KACT_PLUGIN_ZIP）`, "missing");
    return { ...readPluginZip(zip), kind: "zip" };
  }
  const dev = opt.devPluginDir;
  const devAllowed = mode === "dev" && !!dev;
  if (!devAllowed) {
    throw new PluginZipError(`kSQL アクションの zip の場所が分からない。.env に KACT_PLUGIN_ZIP=<kSQL アクションプラグインの zip のパス> を書く${mode === "dev" ? "（開発中に隣の ksql-action の prod/ を読むなら環境変数 KACT_ALLOW_DEV_PLUGIN=1）" : ""}`, "not-configured");
  }
  if (!dev || !existsSync(path.join(dev, ENGINE_ENTRY))) throw new PluginZipError(`kSQL アクションの zip の場所が分からない（KACT_ALLOW_DEV_PLUGIN=1 だが ksql-action の prod/ が無い: ${dev}）。.env に KACT_PLUGIN_ZIP を書く`, "not-configured");
  const read = (rel: string): string => readFileSync(path.join(dev, rel), "utf8");
  const apiFile = path.join(dev, API_ENTRY);
  const engine = read(ENGINE_ENTRY);
  const bignumber = read(BIGNUMBER_ENTRY);
  const decimalFile = path.join(dev, DECIMAL_ENTRY);
  const decimal = existsSync(decimalFile) ? readFileSync(decimalFile, "utf8") : undefined;
  const momentTimezone = read(MOMENT_TZ_ENTRY);
  const api = existsSync(apiFile) ? readFileSync(apiFile, "utf8") : undefined;
  const manifest = JSON.parse(read(MANIFEST_ENTRY)) as PluginSources["manifest"];
  return {
    kind: "dev",
    from: dev,
    manifest,
    pluginVersion: String(manifest.version ?? ""),
    engine,
    bignumber,
    ...(decimal ? { decimal } : {}),
    momentTimezone,
    api,
    sha256: { engine: sha256Hex(engine), ...(api ? { api: sha256Hex(api) } : {}), bignumber: sha256Hex(bignumber), ...(decimal ? { decimal: sha256Hex(decimal) } : {}), momentTimezone: sha256Hex(momentTimezone) }
  };
}

export async function loadEngine(opt: LoadEngineOptions = {}): Promise<Engine> {
  while (loading) await loading.catch(() => undefined);
  if (loaded) return sameEngine(loaded, opt);
  if (poisoned) {
    throw new PluginZipError(
      `kSQL アクションの zip の読み込みに一度失敗した（${poisoned.code}）。そのコードとグローバルがこのプロセスに残っているので、読み込み直せない（起動し直す）`,
      "restart-required",
      { ...poisoned.info, previous: poisoned.code }
    );
  }
  const run = loadOnce(opt);
  loading = run;
  try {
    return await run;
  } finally {
    if (loading === run) loading = null;
  }
}

/** 読み込んだ後の呼び出し: 読み込み元を渡されたら、読み込んだものと同じとき（zip は実体・大きさ・更新日時、dev はフォルダーの実体）だけ返す。渡さなければ読み込んだもの */
function sameEngine(engine: Engine, opt: LoadEngineOptions): Engine {
  const want = requestedStamp(opt);
  if (want === undefined) return engine;
  if (!sameStamp(want, loadedStamp)) {
    throw new PluginZipError(
      `kSQL アクションの zip（読み込み元）が、読み込んだもの（${path.basename(loadedStamp?.real ?? engine.source.from)}）と違う、または読み込んだ後に変わった: ${opt.pluginZip ?? opt.devPluginDir}。1 つのプロセスで読める zip は 1 つ（起動し直す）`,
      "zip-changed",
      { pluginVersion: engine.source.pluginVersion }
    );
  }
  return engine;
}

async function loadOnce(opt: LoadEngineOptions): Promise<Engine> {
  const meta = toolsMeta();
  const stamp = requestedStamp(opt) ?? null;
  const src = resolvePluginSources(opt, opt.mode ?? meta.mode);
  const known = { pluginVersion: src.pluginVersion };
  const warnings: string[] = [];
  // 実行してよいか: 外側の zip の PUBKEY から出るプラグイン ID がkSQL アクションのものか（1.1.0。Takashi 2026-10-08「pluginid のチェックのみで OK」。SIGNATURE は見ない）
  if (src.kind === "zip" && src.pluginId !== KSQL_ACTION_PLUGIN_ID) {
    throw new PluginZipError(`kSQL アクションプラグインの zip ではない（プラグイン ID ${src.pluginId ?? "不明（PUBKEY が無い）"}。kSQL アクションは ${KSQL_ACTION_PLUGIN_ID}）: ${src.from}。配布元から入手したkSQL アクションの zip を KACT_PLUGIN_ZIP に書く`, "not-ksql-action", known);
  }
  if (src.kind === "dev") warnings.push(`開発中の ksql-action（${src.from}。KACT_ALLOW_DEV_PLUGIN=1）から読む。プラグイン ID は確かめない`);
  if (!isSupportedPluginVersion(src.pluginVersion)) {
    throw new PluginZipError(`kSQL アクションプラグインの版 ${src.pluginVersion || "不明"}（${src.from}）には対応していない。tools が扱うのは Ver.${MIN_PLUGIN_VERSION} 以降`, "unsupported-version", known);
  }
  if (!src.api) throw new PluginZipError(`kSQL アクションの zip に ${API_ENTRY} が無い（Ver.${MIN_PLUGIN_VERSION} 以降の zip が要る）: ${src.from}`, "no-api", known);
  if (!existsSync(MOMENT_FILE)) throw new Error(`moment が無い: ${MOMENT_FILE}（tools の npm install 時に取る。手で取るなら npm run vendor）`);
  // ここから先はグローバルを書き換え、zip のコードを動かす。失敗したら、このプロセスでは読み込み直さない（restart-required）
  try {
    return await startEngine({ ...src, api: src.api }, known, warnings, stamp);
  } catch (e) {
    poisoned = { code: e instanceof PluginZipError ? e.code : "unexpected", info: e instanceof PluginZipError ? e.info : known };
    throw e;
  }
}

async function startEngine(src: PluginSources & { kind: "zip" | "dev"; api: string }, known: PluginZipErrorInfo, warnings: string[], stamp: SourceStamp | null): Promise<Engine> {
  const g = globalThis as Record<string, unknown>;
  const { Window } = (await import("happy-dom")) as unknown as { Window: new (opt: { url: string }) => Record<string, unknown> };
  const ctx: KintoneContext = { baseUrl: DEFAULT_CONTEXT_BASE_URL, appId: 1, loginUser: { ...DEFAULT_USER } };
  const window = new Window({ url: `${ctx.baseUrl}/k/${ctx.appId}/show` });
  for (const k of ["document", "Node", "Element", "HTMLElement", "HTMLDivElement", "HTMLImageElement", "HTMLIFrameElement", "DOMParser", "Event", "CSS", "getComputedStyle", "Blob", "File", "URL", "DOMRect", "requestAnimationFrame", "cancelAnimationFrame"]) {
    const v = window[k];
    if (v !== undefined && g[k] === undefined) g[k] = k === "getComputedStyle" && typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(window) : v;
  }
  g.window = window;

  const kintone = {
    getLoginUser: () => ({ ...ctx.loginUser, isGuest: false }),
    app: { getId: () => ctx.appId },
    mobile: { app: { getId: () => ctx.appId } },
    api: Object.assign(() => Promise.reject(new Error("kintone.api is not available in authoring tools")), {
      url: (p: string, _guest?: boolean) => `${ctx.baseUrl}${p.startsWith("/") ? "" : "/"}${p}`
    }),
    $PLUGIN_ID: "authoring"
  };
  g.kintone = kintone;
  g.cybozu = { data: { IS_MOBILE_DEVICE: false } };
  const u = ctx.loginUser;
  const infoUser = { id: u.id, code: u.code, name: u.name, email: u.email, primaryOrganization: null, organizations: [], groups: [] };
  const usersInfo = {
    users: [infoUser], organizations: [], groups: [],
    userCodes: { [u.code]: infoUser }, orgCodes: {}, groupCodes: {},
    userIds: { [u.id]: u.code }, orgIds: {}, groupIds: {}
  };
  // data は差し替えられるように持つ（setUsers）
  const users: { data: unknown } = { data: usersInfo };
  g.rex0220_users_info3 = {
    request: () => undefined,
    getUsersInfo: async () => users.data,
    get data() {
      return users.data;
    }
  };
  window.kintone = g.kintone;
  window.cybozu = g.cybozu;
  window.rex0220_users_info3 = g.rex0220_users_info3;

  const runScript = (code: string, filename: string, entry?: string): void => {
    try {
      vm.runInThisContext(code, { filename });
    } catch (e) {
      if (!entry) throw e;
      throw new PluginZipError(`kSQL アクションの zip のコード（${entry}）を実行できない: ${e instanceof Error ? e.message : String(e)}`, "engine-unreadable", known);
    }
    for (const k of ["moment", "rex0220_BigNumber", "rex0220_Decimal", "rex0220p", "rex0220KsqlActionAuthoring"]) {
      if (g[k] === undefined && window[k] !== undefined) g[k] = window[k];
      if (window[k] === undefined && g[k] !== undefined) window[k] = g[k];
    }
  };
  runScript(readFileSync(MOMENT_FILE, "utf8"), MOMENT_FILE);
  runScript(src.momentTimezone, `${src.from}!${MOMENT_TZ_ENTRY}`, MOMENT_TZ_ENTRY);
  runScript(src.bignumber, `${src.from}!${BIGNUMBER_ENTRY}`, BIGNUMBER_ENTRY);
  // Ver.9 から。エンジンは読み込んだときの rex0220_Decimal を持つので、エンジンより前に読む。無い zip（Ver.8 まで）は読まない（warning にもしない）
  if (src.decimal) runScript(src.decimal, `${src.from}!${DECIMAL_ENTRY}`, DECIMAL_ENTRY);
  runScript(src.engine, `${src.from}!${ENGINE_ENTRY}`, ENGINE_ENTRY);
  runScript(src.api, `${src.from}!${API_ENTRY}`, API_ENTRY);
  const rex0220p = window.rex0220p as { KintoneFormulaKact?: FormulaCtor } | undefined;
  const Ctor = rex0220p?.KintoneFormulaKact;
  if (typeof Ctor !== "function") throw new PluginZipError(`kSQL アクションの計算式エンジン（KintoneFormulaKact）が読めない: ${src.from}`, "engine-unreadable", known);
  const api = window.rex0220KsqlActionAuthoring as KsqlActionAuthoringApi | undefined;
  if (!api || typeof api !== "object") throw new PluginZipError("kSQL アクションの authoring API（rex0220KsqlActionAuthoring）が読めない", "api-unreadable", known);
  const withApi = { ...known, apiVersion: api.apiVersion as unknown };
  if (!SUPPORTED_API_VERSIONS.includes(api.apiVersion)) throw new PluginZipError(`kSQL アクションの authoring API の版 ${String(api.apiVersion)} には対応していない（tools は ${SUPPORTED_API_VERSIONS.join(", ")}）。tools を新しい版にする`, "api-unsupported", withApi);
  if (String(api.pluginVersion) !== src.pluginVersion) throw new PluginZipError(`authoring API のkSQL アクションの版 ${String(api.pluginVersion)} が zip の manifest の版 ${src.pluginVersion} と違う（組み替えられた zip）`, "api-mismatch", withApi);
  const bad = Object.entries(requiredApiFor(api.apiVersion)).filter(([k, t]) => typeof (api as unknown as Record<string, unknown>)[k] !== t).map(([k]) => k);
  if (bad.length) throw new PluginZipError(`kSQL アクションの authoring API に tools が使うものが無い、または型が違う: ${bad.join(", ")}（tools とkSQL アクションの版を合わせる）`, "api-incomplete", withApi);

  loaded = {
    window,
    Ctor,
    api,
    source: { kind: src.kind, from: src.from, pluginVersion: src.pluginVersion, engineSha256: src.sha256.engine, apiSha256: src.sha256.api, ...(src.sha256.decimal ? { decimalSha256: src.sha256.decimal } : {}), ...(src.pluginId ? { pluginId: src.pluginId } : {}) },
    warnings,
    setContext(next) {
      if (next.baseUrl) ctx.baseUrl = next.baseUrl.replace(/\/+$/, "");
      if (next.appId) ctx.appId = next.appId;
      if (next.loginUser) ctx.loginUser = { ...ctx.loginUser, ...next.loginUser };
    },
    setUsers(table) {
      users.data = table;
    },
    checker: (pp, crec) => new Ctor("formula", pp, crec, true, true),
    runner: (pp, record) => new Ctor("formula", pp, record, true),
    functionNames: () => Object.keys(new Ctor("formula", {}, {}, true, true).funs).sort()
  };
  loadedStamp = stamp;
  return loaded;
}
