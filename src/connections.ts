/**
 * kintone の接続のファイル（kSQL の ksql.config.json と同じ形）。**印刷屋の tools からの写し**（`src/connections.ts`。あちらが正本。
 * 直すときは向こうの変更も見る）。kSQL アクションでは**アプリのフォルダーの印は持たない**ので、その分の誤りの種類だけ外した。
 *   - 読むキーは defaultProfile と profiles.<名前> の baseUrl / guestSpaceId / auth / username / password / passwordEnv / tokenMap だけ。
 *     ほかのキー（kSQL の query・output・dml・logicalApps など）と知らないキーは読まずに通す（kSQL も知らないキーを無視する）
 *   - kSQL の環境変数の上書き（KSQL_BASE_URL、KSQL_TOKEN、KSQL_PROFILE など）は読まない。読む環境変数は、ファイルが名前を書いた env: と passwordEnv だけ（15.2）
 *   - 置き場所は作業フォルダーの外（誤操作の防止。Claude Code の AI はファイルも環境変数も読める = 受け入れた危険。15.3）。
 *     実際のパスを開き、開いたファイルが普通のファイルで 256 KiB 以下かを確かめてから読む
 *   - 1 つの profile は 1 つのスペース（guestSpaceId が無ければ通常のスペース。15.5）
 *   - 中核は process.env と設定の場所を読まない。呼ぶ側（MCP の入口）が渡す
 *   - 誤りの文は決まった文だけ（profile の名前、アプリの番号、キーの名前、ファイルの名前まで。値・絶対パス・環境変数の名前・JSON の断片を入れない）
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { realpathSync, type Stats } from "node:fs";
import path from "node:path";
import type { KintoneAuth } from "./kintone-rest.ts";
import { normalizeKintoneBaseUrl } from "./kintone-url.ts";
import { isInside } from "./workspace.ts";

export const CONNECTION_MAX_BYTES = 256 * 1024;

/** 接続のファイルを読むときの fs の呼び出し（試験だけが差し替える。読み込みの途中の書き換えを再現するため。中核の入口 core.ts からは出さない） */
interface FsOps {
  openSync: (p: string, flags: string) => number;
  fstatSync: (fd: number) => Stats;
  readSync: (fd: number, buf: Buffer, offset: number, length: number, position: number) => number;
  closeSync: (fd: number) => void;
  statSync: (p: string) => Stats;
}
const REAL_FS: FsOps = {
  openSync: (p, flags) => nodeFs.openSync(p, flags),
  fstatSync: (fd) => nodeFs.fstatSync(fd),
  readSync: (fd, buf, offset, length, position) => nodeFs.readSync(fd, buf, offset, length, position),
  closeSync: (fd) => nodeFs.closeSync(fd),
  statSync: (p) => nodeFs.statSync(p)
};
let fsOps: FsOps = REAL_FS;
/** 試験用: fs の呼び出しを差し替える（undefined で元に戻す） */
export function setFsOpsForTest(ops?: Partial<FsOps>): void {
  fsOps = ops ? { ...REAL_FS, ...ops } : REAL_FS;
}
/** profile の名前（kintone/<profile>/ のフォルダーの名前になる） */
export const PROFILE_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** kSQL と同じ: 引数も defaultProfile も無ければ dev（15.1 の 8） */
export const FALLBACK_PROFILE = "dev";

/** 誤りの種類（status は呼ぶ側が決める: inside-workspace は denied、unknown-profile は invalid、connection-changed は conflict、ほかは failed） */
export type ConnectionErrorCode =
  | "not-configured"
  | "unreadable"
  | "inside-workspace"
  | "unknown-profile"
  | "no-default-profile"
  | "profile-invalid"
  | "no-token"
  | "env-missing"
  | "no-userpass"
  | "guest-mismatch"
  | "connection-changed";

export class ConnectionError extends Error {
  readonly code: ConnectionErrorCode;
  constructor(message: string, code: ConnectionErrorCode) {
    super(message);
    this.code = code;
  }
}

export type Env = Readonly<Record<string, string | undefined>>;

/** profile の秘密でない識別（アプリのフォルダーの印と、確定の前の比較に使う） */
export interface ProfileIdentity {
  profile: string;
  baseUrl: string;
  host: string;
  /** ゲストスペースの番号（通常のスペースは null） */
  guestSpaceId: number | null;
}

export interface ProfileDef extends ProfileIdentity {
  /** auto を解決した後の認証の種類 */
  auth: "token" | "userpass";
  /** tokenMap のアプリの番号（値は持たない） */
  tokenApps: number[];
  /** アプリごとに、トークンが使えるか（env: の変数があるか。変数の名前は持たない） */
  tokenReady: Record<number, boolean>;
  /** ログイン名とパスワードがそろっているか（userpass のとき） */
  userpassReady: boolean;
}

export interface ConnectionSet {
  /** 接続のファイルの名前（パスは持たない。応答に出してよいのはこれだけ） */
  fileName: string;
  /** 中身の sha256 */
  digest: string;
  /** ファイルに書いた defaultProfile（無ければ undefined） */
  defaultProfile?: string;
  /** 使える profile */
  profiles: ReadonlyMap<string, ProfileDef>;
  /** 使えない profile と理由（決まった文。値を含まない） */
  invalid: ReadonlyArray<{ name: string; reason: string }>;
  /** 警告（ほかの利用者が読める、など。パスを含まない） */
  warnings: readonly string[];
}

/**
 * 接続のスナップショット（15.6）: 呼び出しの初めに選んだ profile の秘密でない値。kintone の API・保存先・アプリのフォルダーの印・preview の接続先に同じものを使い、
 * 確定の直前に読み直した profile の意味の digest（semanticDigest）と比べる。ファイル全体の digest は使わない（ほかの profile だけの書き換えでは止めない）
 */
export interface ConnectionSnapshot extends ProfileIdentity {
  auth: "token" | "userpass";
  /** 読んだ接続のファイルの名前（文に出してよいのはこれだけ） */
  fileName: string;
}

interface ProfileSecrets {
  username?: string;
  password?: string;
  /** アプリの番号 → 値（env:<NAME> か、トークンそのもの） */
  tokens: Map<number, string>;
}

/** 秘密の値は ConnectionSet の外に持つ（JSON にしたとき・表示したときに出ないように） */
const SECRETS = new WeakMap<ConnectionSet, { env: Env; byProfile: Map<string, ProfileSecrets> }>();
/** 資格情報の指紋の鍵（プロセスごとの乱数。指紋はこのプロセスの中で比べるだけで、外に出さない。15.6、r3 MAJOR 1） */
const FINGERPRINT_KEY = randomBytes(32);
const fingerprint = (parts: readonly string[]): string => createHmac("sha256", FINGERPRINT_KEY).update(JSON.stringify(parts)).digest("hex");

/** 空白だけ・文字列でないものは無いとみなす。値はそのまま返す（前後の空白も変えない。kSQL と同じく値は加工しない。Codex の実装レビュー MAJOR 2） */
const nonblank = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** tokenMap のキーを APP<N> の N に（APP<N> / app<N> / <N>。N は先頭が 0 でない正の安全な整数。kSQL の normalizeAppKey と同じ形を受ける） */
function appKeyOf(key: string): number | undefined {
  const m = /^(?:APP)?([1-9][0-9]*)$/i.exec(key);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** 1 つの profile を読む。誤りがあれば理由（決まった文）を返す */
function readProfile(name: string, raw: unknown, env: Env): { def: ProfileDef; secrets: ProfileSecrets } | { reason: string } {
  if (!PROFILE_NAME_RE.test(name)) return { reason: "profile の名前は英数字と - _ の 40 文字まで（フォルダーの名前になる）" };
  if (!isPlainObject(raw)) return { reason: "profile がオブジェクトでない" };
  // 型は 15.2 のとおり厳しく（文字列に直して受け付けない。Codex の実装レビュー MAJOR 2）
  if (typeof raw.baseUrl !== "string") return { reason: "baseUrl が無い、または文字列でない" };
  for (const k of ["username", "password", "passwordEnv"] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== "string") return { reason: `${k} が文字列でない` };
  }
  let baseUrl: string;
  try {
    baseUrl = normalizeKintoneBaseUrl(raw.baseUrl);
  } catch {
    return { reason: "baseUrl が kintone の URL でない（https://<サブドメイン>.cybozu.com / .kintone.com / .cybozu.cn だけ。パス・ポート・ユーザー情報なし）" };
  }
  let guestSpaceId: number | null = null;
  if (raw.guestSpaceId !== undefined && raw.guestSpaceId !== null) {
    if (typeof raw.guestSpaceId !== "number" || !Number.isSafeInteger(raw.guestSpaceId) || raw.guestSpaceId <= 0) return { reason: "guestSpaceId は正の整数" };
    guestSpaceId = raw.guestSpaceId;
  }
  const mode = raw.auth ?? "auto";
  if (mode !== "token" && mode !== "userpass" && mode !== "auto") return { reason: "auth は token / userpass / auto のどれか" };
  if (raw.passwordEnv !== undefined && (typeof raw.passwordEnv !== "string" || !ENV_NAME_RE.test(raw.passwordEnv))) return { reason: "passwordEnv は環境変数の名前（英字か _ で始まる英数字と _）" };
  const username = nonblank(raw.username);
  const password = (typeof raw.passwordEnv === "string" ? nonblank(env[raw.passwordEnv]) : undefined) ?? nonblank(raw.password);
  const tokens = new Map<number, string>();
  if (raw.tokenMap !== undefined) {
    if (!isPlainObject(raw.tokenMap)) return { reason: "tokenMap がオブジェクトでない" };
    for (const key of Object.keys(raw.tokenMap)) {
      const appId = appKeyOf(key);
      if (appId === undefined) return { reason: `tokenMap のキー「${key.slice(0, 40)}」はアプリの番号でない（APP101 か 101。先頭に 0 を付けない）` };
      if (tokens.has(appId)) return { reason: `tokenMap にアプリ ${appId} が 2 つある（APP${appId} と ${appId} など）` };
      const value = raw.tokenMap[key];
      if (typeof value !== "string" || !value.trim()) return { reason: `tokenMap の APP${appId} の値が文字列でない、または空` };
      if (value.startsWith("env:") && !ENV_NAME_RE.test(value.slice(4))) return { reason: `tokenMap の APP${appId} の env: の後ろが環境変数の名前でない` };
      tokens.set(appId, value);
    }
  }
  const auth = mode === "auto" ? (username && password ? "userpass" : "token") : mode;
  const tokenApps = [...tokens.keys()].sort((a, b) => a - b);
  const tokenReady: Record<number, boolean> = {};
  for (const [appId, value] of tokens) tokenReady[appId] = value.startsWith("env:") ? !!nonblank(env[value.slice(4)]) : true;
  const host = new URL(baseUrl).hostname;
  return {
    def: { profile: name, baseUrl, host, guestSpaceId, auth, tokenApps, tokenReady, userpassReady: !!(username && password) },
    secrets: {
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      tokens
    }
  };
}

function realOf(p: string): string {
  return realpathSync.native(p);
}

/** ファイルの識別（読み込みの途中の書き換え・名前の付け替えを見つける。Windows で ino が 0 のときは大きさと更新日時で比べる。15.3） */
const sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

const changed = (name: string): ConnectionError => new ConnectionError(`接続のファイル（${name}）が読み込みの途中で変わった`, "unreadable");

/**
 * 1 回の安定した読み込み: 実際のパスを開き、開いた fd が普通のファイルで上限以下なら fd から読む（上限 + 1 バイトで止める）。
 * 読んだ後に fd と実際のパスの識別（dev・ino・大きさ・更新日時）が読む前と同じで、読んだバイト数が大きさと同じかを確かめる（15.3）
 */
function readStable(real: string, name: string): { bytes: Buffer; stat: Stats } {
  let fd: number | undefined;
  try {
    fd = fsOps.openSync(real, "r");
    const before = fsOps.fstatSync(fd);
    if (!before.isFile()) throw new ConnectionError(`接続のファイル（${name}）が普通のファイルでない（フォルダーなど）`, "unreadable");
    if (before.size > CONNECTION_MAX_BYTES) throw new ConnectionError(`接続のファイル（${name}）が大きすぎる（上限 ${CONNECTION_MAX_BYTES} バイト）`, "unreadable");
    const buf = Buffer.alloc(CONNECTION_MAX_BYTES + 1);
    let off = 0;
    for (;;) {
      const n = fsOps.readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
      if (off > CONNECTION_MAX_BYTES) throw new ConnectionError(`接続のファイル（${name}）が大きすぎる（上限 ${CONNECTION_MAX_BYTES} バイト）`, "unreadable");
    }
    const after = fsOps.fstatSync(fd);
    let onPath: Stats;
    try {
      onPath = fsOps.statSync(real);
    } catch {
      throw changed(name);
    }
    if (!sameFile(before, after) || !sameFile(before, onPath) || off !== before.size) throw changed(name);
    return { bytes: Buffer.from(buf.subarray(0, off)), stat: before };
  } catch (e) {
    if (e instanceof ConnectionError) throw e;
    throw new ConnectionError(`接続のファイル（${name}）を読めない`, "unreadable");
  } finally {
    if (fd !== undefined) fsOps.closeSync(fd);
  }
}

/**
 * 接続のファイルを読む。ino が取れない（0 の）とき（Windows の一部）は、同じ大きさ・更新日時のファイルへの付け替えを識別で見分けられないので、
 * もう一度同じ検査で読み、2 回の中身が同じときだけ使う（r3 MAJOR 2。2 回目も同じ検査にする。Codex の実装レビュー MAJOR 5）
 */
function readRegularFile(real: string, name: string): { bytes: Buffer; mode: number } {
  const first = readStable(real, name);
  if (first.stat.ino === 0) {
    const second = readStable(real, name);
    if (!first.bytes.equals(second.bytes)) throw changed(name);
  }
  return { bytes: first.bytes, mode: first.stat.mode };
}

/**
 * 秘密の値（パスワード、env: でないトークン）がファイルに直接書いてあるか（使えない profile も数える。passwordEnv と env: の参照は数えない。
 * ほかの利用者が読める権限の警告に使う。Codex の実装レビュー MAJOR 2）
 */
function hasInlineSecrets(rawProfiles: Record<string, unknown>): boolean {
  for (const key of Object.keys(rawProfiles)) {
    const p = rawProfiles[key];
    if (!isPlainObject(p)) continue;
    if (nonblank(p.password)) return true;
    if (isPlainObject(p.tokenMap) && Object.values(p.tokenMap).some((v) => typeof v === "string" && v.trim() !== "" && !v.startsWith("env:"))) return true;
  }
  return false;
}

export interface LoadConnectionsOptions {
  /** そのプロセスが知っている作業フォルダー（この中の接続のファイルは使わない） */
  workspaceRoots: readonly string[];
  /** env: と passwordEnv を引く環境変数（中核は process.env を読まない） */
  env: Env;
}

/**
 * 接続のファイルを読む（15.2、15.3）。file は絶対パス（設定の値の ~ の展開と引用符を外すのは呼ぶ側）。
 * 読めない・作業フォルダーの中は ConnectionError。profile ごとの誤りは invalid に入れる（ほかの profile は使える）
 */
export function loadConnections(file: string | undefined, opt: LoadConnectionsOptions): ConnectionSet {
  if (!file || !file.trim()) throw new ConnectionError("kintone の接続のファイルが設定されていない（ksql.config.json と同じ形のファイル）", "not-configured");
  const name = path.basename(file);
  if (!path.isAbsolute(file)) throw new ConnectionError(`接続のファイル（${name}）は絶対パスで指定する`, "unreadable");
  let real: string;
  try {
    real = realOf(file);
  } catch {
    throw new ConnectionError(`接続のファイル（${name}）が無い、または読めない`, "unreadable");
  }
  // 実際のパスも、指定されたパスそのもの（作業フォルダーの中の symlink が外を指すときも、AI は作業フォルダーのファイルとして読める）も、作業フォルダーの外のときだけ
  const given = path.resolve(file);
  for (const root of opt.workspaceRoots) {
    let rootReal: string;
    try {
      rootReal = realOf(root);
    } catch {
      continue;
    }
    if (isInside(real, rootReal) || isInside(given, rootReal) || isInside(given, path.resolve(root))) {
      throw new ConnectionError(`接続のファイル（${name}）が作業フォルダーの中にある。作業フォルダーの外に置く`, "inside-workspace");
    }
  }
  const { bytes, mode } = readRegularFile(real, name);
  let again: string | undefined;
  try {
    again = realOf(file);
  } catch {
    again = undefined;
  }
  if (again !== real) throw new ConnectionError(`接続のファイル（${name}）が読み込みの途中で変わった`, "unreadable");
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ConnectionError(`接続のファイル（${name}）を JSON として読めない`, "unreadable");
  }
  if (!isPlainObject(data)) throw new ConnectionError(`接続のファイル（${name}）の最上位がオブジェクトでない`, "unreadable");
  const rawProfiles = data.profiles ?? {};
  if (!isPlainObject(rawProfiles)) throw new ConnectionError(`接続のファイル（${name}）の profiles がオブジェクトでない`, "unreadable");
  const profiles = new Map<string, ProfileDef>();
  const byProfile = new Map<string, ProfileSecrets>();
  const invalid: Array<{ name: string; reason: string }> = [];
  for (const key of Object.keys(rawProfiles)) {
    const r = readProfile(key, rawProfiles[key], opt.env);
    if ("reason" in r) invalid.push({ name: key.slice(0, 40), reason: r.reason });
    else {
      profiles.set(key, r.def);
      byProfile.set(key, r.secrets);
    }
  }
  // 大文字小文字だけが違う profile は、Mac・Windows で同じフォルダーになるので、どちらも使わない
  const lower = new Map<string, string[]>();
  for (const key of profiles.keys()) lower.set(key.toLowerCase(), [...(lower.get(key.toLowerCase()) ?? []), key]);
  for (const keys of lower.values()) {
    if (keys.length < 2) continue;
    for (const key of keys) {
      profiles.delete(key);
      byProfile.delete(key);
      invalid.push({ name: key, reason: `大文字小文字だけが違う profile がある（${keys.join("、")}）` });
    }
  }
  if (data.defaultProfile !== undefined && typeof data.defaultProfile !== "string") throw new ConnectionError(`接続のファイル（${name}）の defaultProfile が文字列でない`, "unreadable");
  const defaultProfile = data.defaultProfile as string | undefined;
  const warnings: string[] = [];
  if (process.platform !== "win32" && hasInlineSecrets(rawProfiles) && (mode & 0o077) !== 0) warnings.push(`接続のファイル（${name}）に秘密の値が直接書いてあり、ほかの利用者も読める。chmod 600 を勧める`);
  const set: ConnectionSet = { fileName: name, digest: createHash("sha256").update(bytes).digest("hex"), ...(defaultProfile !== undefined ? { defaultProfile } : {}), profiles, invalid, warnings };
  SECRETS.set(set, { env: opt.env, byProfile });
  return set;
}

/** profile を選ぶ（15.2: 引数 → defaultProfile → "dev"） */
export function pickProfile(set: ConnectionSet, name?: string): ProfileDef {
  const bad = (n: string): string | undefined => set.invalid.find((p) => p.name === n)?.reason;
  if (name !== undefined) {
    const def = set.profiles.get(name);
    if (def) return def;
    const reason = bad(name);
    if (reason) throw new ConnectionError(`profile「${name.slice(0, 40)}」は使えない: ${reason}`, "profile-invalid");
    throw new ConnectionError(`profile「${name.slice(0, 40)}」は接続のファイル（${set.fileName}）に無い`, "unknown-profile");
  }
  if (set.defaultProfile !== undefined) {
    const def = set.profiles.get(set.defaultProfile);
    if (def) return def;
    const reason = bad(set.defaultProfile);
    throw new ConnectionError(`defaultProfile の「${set.defaultProfile.slice(0, 40)}」が${reason ? `使えない: ${reason}` : "接続のファイルの profiles に無い"}`, "profile-invalid");
  }
  const def = set.profiles.get(FALLBACK_PROFILE);
  if (def) return def;
  const reason = bad(FALLBACK_PROFILE);
  if (reason) throw new ConnectionError(`profile「${FALLBACK_PROFILE}」は使えない: ${reason}`, "profile-invalid");
  throw new ConnectionError(`profile を指定するか、接続のファイル（${set.fileName}）に defaultProfile を書く（無ければ "${FALLBACK_PROFILE}" を使うが、それも無い）`, "no-default-profile");
}

/** 選んだ profile のスナップショット（15.6） */
export function snapshotOf(set: ConnectionSet, def: ProfileDef): ConnectionSnapshot {
  return { ...identityOf(def), auth: def.auth, fileName: set.fileName };
}

/**
 * 選んだ profile の意味の digest（15.6）: profile、接続先、ゲストスペース、認証の種類、対象のアプリと、資格情報の指紋（解決したログイン名とパスワード、
 * または対象のアプリのトークンの HMAC。鍵はプロセスごとの乱数）。直接書いた値・ログイン名・env: の参照先の値の入れ替えも違う digest になる（r3 MAJOR 1）。
 * この digest も指紋も外に出さない（このプロセスの中で比べるだけ）
 */
export function semanticDigest(set: ConnectionSet, def: ProfileDef, appId?: number): string {
  const held = SECRETS.get(set);
  const secrets = held?.byProfile.get(def.profile);
  let credential = "none";
  if (def.auth === "userpass") credential = fingerprint(["userpass", secrets?.username ?? "", secrets?.password ?? ""]);
  else if (appId !== undefined) {
    const v = secrets?.tokens.get(appId);
    const value = v === undefined ? "" : v.startsWith("env:") ? (nonblank(held?.env[v.slice(4)]) ?? "") : v;
    credential = fingerprint(["token", v?.startsWith("env:") ? v : "inline", value]);
  }
  return createHash("sha256").update(JSON.stringify([def.profile, def.baseUrl, def.guestSpaceId, def.auth, credential, appId ?? null])).digest("hex");
}

/** 確定の直前に、読み直した接続で同じ profile の意味の digest が同じか（違えば connection-changed） */
export function assertSameConnection(before: { set: ConnectionSet; def: ProfileDef }, reload: () => ConnectionSet, appId?: number): void {
  const want = semanticDigest(before.set, before.def, appId);
  let now: string;
  try {
    const set = reload();
    now = semanticDigest(set, pickProfile(set, before.def.profile), appId);
  } catch (e) {
    if (e instanceof ConnectionError && (e.code === "unknown-profile" || e.code === "profile-invalid")) throw new ConnectionError(`profile「${before.def.profile}」の接続が途中で変わった（使えなくなった）。もう一度やり直す`, "connection-changed");
    throw e;
  }
  if (now !== want) throw new ConnectionError(`profile「${before.def.profile}」の接続が途中で変わった。もう一度やり直す`, "connection-changed");
}

/** アプリ N の認証（15.2）。対象のアプリのトークンだけを解決する */
export function authFor(set: ConnectionSet, profile: ProfileDef, appId: number): KintoneAuth {
  const held = SECRETS.get(set);
  const secrets = held?.byProfile.get(profile.profile);
  if (!held || !secrets) throw new ConnectionError(`profile「${profile.profile}」の接続が読み込まれていない`, "profile-invalid");
  if (profile.auth === "userpass") {
    if (!secrets.username || !secrets.password) throw new ConnectionError(`profile「${profile.profile}」のログイン名とパスワードがそろわない（username と password か passwordEnv）`, "no-userpass");
    return { baseUrl: profile.baseUrl, username: secrets.username, password: secrets.password };
  }
  const value = secrets.tokens.get(appId);
  if (value === undefined) throw new ConnectionError(`profile「${profile.profile}」の tokenMap に APP${appId} が無い（そのアプリの API トークンを足す）`, "no-token");
  if (value.startsWith("env:")) {
    const token = nonblank(held.env[value.slice(4)]);
    if (!token) throw new ConnectionError(`profile「${profile.profile}」の APP${appId} のトークンの環境変数が無い（設定した後、kact の MCP を再接続する。Desktop は起動し直す）`, "env-missing");
    return { baseUrl: profile.baseUrl, token };
  }
  return { baseUrl: profile.baseUrl, token: value };
}

export function identityOf(def: ProfileDef): ProfileIdentity {
  return { profile: def.profile, baseUrl: def.baseUrl, host: def.host, guestSpaceId: def.guestSpaceId };
}

export function sameIdentity(a: ProfileIdentity, b: ProfileIdentity): boolean {
  return a.profile === b.profile && a.baseUrl === b.baseUrl && a.guestSpaceId === b.guestSpaceId;
}
