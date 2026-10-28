/**
 * kSQL アクションプラグインの zip を読む（docs/authoring-plan.md 12.9 の 9。Takashi「npm + kintone MCP + kSQL アクションプラグイン.zip」）。
 * kintone のプラグイン zip は contents.zip + PUBKEY + SIGNATURE の 2 層。contents.zip の中から
 *   desktop_js/KintoneFormulaKact.min.js（計算式エンジン）、desktop_js/bignumber.min.js、desktop_js/moment-timezone-with-data.min.js、
 *   config_js/ksql-action-authoring-api.js（kSQL アクションの設定画面・帳票のコードと kit を tools 向けにまとめた API。Ver.6 で同梱）、manifest.json
 * をメモリに取り出す。ファイルには書き出さない（エンジンとkSQL アクションのコードは利用者の zip の中だけにあり、tools は配らない）。
 * zip の読み取りは Node の zlib だけで行う（依存を足さない。stored と deflate、ZIP64 なし）。
 * 1-10 レビュー BLOCKER 2: zip の中身は後で Node のプロセスで実行するので、読む段階で上限と整合性を確かめる
 *   - 外側の大きさ、entry の数、entry ごとと合計の展開後の大きさ（zip bomb）
 *   - central directory と local header の名前の一致、offset の範囲、展開後の大きさと CRC-32 の一致、同名 entry の重複
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * kSQL アクションの zip の誤りの種類。診断で「読めない」「読めるが合わない」「読み込んだ後に変わった」を分けるため（kact MCP の kact_status。B1 の Codex 再レビュー MAJOR 1）。
 *   not-configured: zip の場所が分からない / missing: zip が無い / unreadable: zip として読めない（壊れている、kSQL アクションの 2 層の形でない、manifest が読めない、大きすぎる）
 *   not-ksql-action: プラグイン ID がkSQL アクションのものでない / unsupported-version: kSQL アクションの版が対応外 / no-api: authoring API が無い
 *   engine-unreadable: zip のコードを実行できない、計算式エンジンが無い / api-unreadable: authoring API が読めない / api-unsupported: authoring API の版が対応外
 *   api-mismatch: authoring API のkSQL アクションの版が manifest と違う（組み替えられた zip） / api-incomplete: authoring API に tools が使うものが無い
 *   zip-changed: 読み込んだ後に別の zip（読み込み元）を渡された、または zip が変わった（1 プロセスに 1 つ）
 *   restart-required: zip のコードを動かし始めた後に読み込みが失敗した（グローバルが残るので、このプロセスでは読み込み直さない。info.previous が前の誤り）
 */
export type PluginZipErrorCode =
  | "not-configured"
  | "missing"
  | "unreadable"
  | "not-ksql-action"
  | "unsupported-version"
  | "no-api"
  | "engine-unreadable"
  | "api-unreadable"
  | "api-unsupported"
  | "api-mismatch"
  | "api-incomplete"
  | "zip-changed"
  | "restart-required";

/** 誤りの時点で分かっているkSQL アクションの版（manifest）と authoring API の版。restart-required は前の誤りの種類（previous） */
export interface PluginZipErrorInfo {
  pluginVersion?: string;
  apiVersion?: unknown;
  previous?: string;
}

export class PluginZipError extends Error {
  readonly code: PluginZipErrorCode;
  readonly info: PluginZipErrorInfo;
  constructor(message: string, code: PluginZipErrorCode = "unreadable", info: PluginZipErrorInfo = {}) {
    super(message);
    this.code = code;
    this.info = info;
  }
}

export interface ZipLimits {
  maxOuterBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

/** kSQL アクションの zip は 1 MB 程度。余裕を見た上限 */
export const ZIP_LIMITS: ZipLimits = {
  maxOuterBytes: 64 * 1024 * 1024,
  maxEntries: 500,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32（zip と同じ。Node 20 には zlib.crc32 が無いので自前） */
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(buf: Buffer, p: number, what: string): number {
  if (p < 0 || p + 2 > buf.length) throw new PluginZipError(`zip が壊れている（${what} が範囲外）`);
  return buf.readUInt16LE(p);
}
function u32(buf: Buffer, p: number, what: string): number {
  if (p < 0 || p + 4 > buf.length) throw new PluginZipError(`zip が壊れている（${what} が範囲外）`);
  return buf.readUInt32LE(p);
}

/** zip の全エントリーを { 名前 → 中身 } に展開する（上限と整合性を確かめる） */
export function unzip(buf: Buffer, limits: ZipLimits = ZIP_LIMITS): Map<string, Buffer> {
  if (buf.length > limits.maxOuterBytes) throw new PluginZipError(`zip が大きすぎる（${buf.length} バイト。上限 ${limits.maxOuterBytes}）`);
  const minEocd = 22;
  let eocd = -1;
  for (let i = buf.length - minEocd; i >= Math.max(0, buf.length - minEocd - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new PluginZipError("zip の終端（EOCD）が無い");
  const total = u16(buf, eocd + 10, "entry 数");
  const cdSize = u32(buf, eocd + 12, "central directory の大きさ");
  const cdOffset = u32(buf, eocd + 16, "central directory の位置");
  if (total > limits.maxEntries) throw new PluginZipError(`zip の entry が多すぎる（${total}。上限 ${limits.maxEntries}）`);
  if (cdOffset + cdSize > eocd) throw new PluginZipError("zip が壊れている（central directory が終端を越える）");
  const out = new Map<string, Buffer>();
  let p = cdOffset;
  let totalBytes = 0;
  for (let n = 0; n < total; n++) {
    if (u32(buf, p, "central directory") !== SIG_CENTRAL) throw new PluginZipError(`zip の central directory が壊れている（entry ${n}）`);
    const method = u16(buf, p + 10, "圧縮方式");
    const crc = u32(buf, p + 16, "CRC");
    const compSize = u32(buf, p + 20, "圧縮後の大きさ");
    const uncompSize = u32(buf, p + 24, "展開後の大きさ");
    const nameLen = u16(buf, p + 28, "名前の長さ");
    const extraLen = u16(buf, p + 30, "extra の長さ");
    const commentLen = u16(buf, p + 32, "コメントの長さ");
    const localOffset = u32(buf, p + 42, "local header の位置");
    if (p + 46 + nameLen > eocd) throw new PluginZipError(`zip が壊れている（entry ${n} の名前が範囲外）`);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (name.startsWith("/") || name.split("/").includes("..")) throw new PluginZipError(`zip の entry 名が不正: ${name}`);
    if (out.has(name)) throw new PluginZipError(`zip に同じ名前の entry が 2 つある: ${name}`);
    if (uncompSize > limits.maxEntryBytes) throw new PluginZipError(`zip の entry が大きすぎる: ${name}（${uncompSize} バイト。上限 ${limits.maxEntryBytes}）`);
    totalBytes += uncompSize;
    if (totalBytes > limits.maxTotalBytes) throw new PluginZipError(`zip の展開後の合計が大きすぎる（上限 ${limits.maxTotalBytes} バイト）`);
    if (u32(buf, localOffset, `local header（${name}）`) !== SIG_LOCAL) throw new PluginZipError(`zip の local header が壊れている: ${name}`);
    const localNameLen = u16(buf, localOffset + 26, "local の名前の長さ");
    const localExtraLen = u16(buf, localOffset + 28, "local の extra の長さ");
    const localName = buf.subarray(localOffset + 30, localOffset + 30 + localNameLen).toString("utf8");
    if (localName !== name) throw new PluginZipError(`zip の entry 名が central directory と local header で違う: ${name} / ${localName}`);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > cdOffset) throw new PluginZipError(`zip が壊れている（${name} のデータが central directory に重なる）`);
    const data = buf.subarray(dataStart, dataStart + compSize);
    let content: Buffer;
    if (method === 0) content = Buffer.from(data);
    else if (method === 8) {
      try {
        content = inflateRawSync(data, { maxOutputLength: Math.max(1, uncompSize) });
      } catch (e) {
        throw new PluginZipError(`zip の entry を展開できない: ${name}（${e instanceof Error ? e.message : String(e)}）`);
      }
    } else throw new PluginZipError(`zip の圧縮方式 ${method} には対応していない: ${name}`);
    if (content.length !== uncompSize) throw new PluginZipError(`zip の entry の大きさが合わない: ${name}（${content.length} / ${uncompSize}）`);
    if (crc32(content) !== crc) throw new PluginZipError(`zip の entry の CRC が合わない（壊れているか改変されている）: ${name}`);
    out.set(name, content);
  }
  return out;
}

export interface PluginManifest {
  manifest_version?: number;
  version?: number | string;
  name?: Record<string, string>;
  [key: string]: unknown;
}

export interface PluginSources {
  /** 入力（zip のパス、または開発中の ksql-action のフォルダー） */
  from: string;
  manifest: PluginManifest;
  pluginVersion: string;
  engine: string;
  bignumber: string;
  /** decimal.js（rex0220_decimal.min.js。kSQL アクション Ver.9 から同梱。数学関数 M_* と財務関数 R_* が使う。Ver.8 までの zip は undefined） */
  decimal?: string;
  momentTimezone: string;
  /** kSQL アクションの authoring API（Ver.6 以降の zip にある。無ければ undefined） */
  api?: string;
  /** プラグイン ID（zip の PUBKEY から。開発中のフォルダーと PUBKEY の無い zip は undefined） */
  pluginId?: string;
  sha256: { engine: string; api?: string; bignumber: string; decimal?: string; momentTimezone: string; contents?: string };
}

export const ENGINE_ENTRY = "desktop_js/KintoneFormulaKact.min.js";
export const BIGNUMBER_ENTRY = "desktop_js/bignumber.min.js";
/** kSQL アクション Ver.9 から（任意。無ければ M_* / R_* はエンジンが「not available」にする。2026-10-20） */
export const DECIMAL_ENTRY = "desktop_js/rex0220_decimal.min.js";
export const MOMENT_TZ_ENTRY = "desktop_js/moment-timezone-with-data.min.js";
export const API_ENTRY = "config_js/ksql-action-authoring-api.js";
export const MANIFEST_ENTRY = "manifest.json";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * プラグイン ID（kintone の @kintone/plugin-packer の uuid と同じ: 外側の zip の PUBKEY（公開鍵の DER）の SHA-256 の先頭 32 桁を 0-9a-f → a-p）。
 * kSQL アクションは 5 変種とも同じ鍵で作るので同じ ID（pull がプラグインの設定を取るときの id。2026-10-05）
 */
export function pluginIdOf(publicKey: Buffer): string {
  return sha256Hex(publicKey).slice(0, 32).replace(/[0-9a-f]/g, (c) => "abcdefghijklmnop"["0123456789abcdef".indexOf(c)]);
}

/** kSQL アクションの zip（2 層）から tools が要るものを取り出す */
export function readPluginZip(file: string): PluginSources {
  let outer: Map<string, Buffer>;
  try {
    const size = statSync(file).size;
    if (size > ZIP_LIMITS.maxOuterBytes) throw new PluginZipError(`大きすぎる（${size} バイト）`);
    outer = unzip(readFileSync(file));
  } catch (e) {
    throw new PluginZipError(`kSQL アクションの zip を読めない: ${file}（${e instanceof Error ? e.message : String(e)}）`);
  }
  const contents = outer.get("contents.zip");
  if (!contents) throw new PluginZipError(`kSQL アクションの zip ではない（contents.zip が無い）: ${file}`);
  let inner: Map<string, Buffer>;
  try {
    inner = unzip(contents);
  } catch (e) {
    throw new PluginZipError(`kSQL アクションの zip の contents.zip を読めない: ${file}（${e instanceof Error ? e.message : String(e)}）`);
  }
  const need = (name: string): Buffer => {
    const b = inner.get(name);
    if (!b) throw new PluginZipError(`kSQL アクションの zip に ${name} が無い: ${file}`);
    return b;
  };
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(need(MANIFEST_ENTRY).toString("utf8")) as PluginManifest;
  } catch (e) {
    throw new PluginZipError(`kSQL アクションの zip の manifest.json を読めない: ${file}（${e instanceof Error ? e.message : String(e)}）`);
  }
  if (!manifest || typeof manifest !== "object") throw new PluginZipError(`kSQL アクションの zip の manifest.json が不正: ${file}`);
  const engine = need(ENGINE_ENTRY);
  const bignumber = need(BIGNUMBER_ENTRY);
  const decimal = inner.get(DECIMAL_ENTRY);
  const momentTimezone = need(MOMENT_TZ_ENTRY);
  const api = inner.get(API_ENTRY);
  const pubkey = outer.get("PUBKEY");
  return {
    from: file,
    ...(pubkey ? { pluginId: pluginIdOf(pubkey) } : {}),
    manifest,
    pluginVersion: String(manifest.version ?? ""),
    engine: engine.toString("utf8"),
    bignumber: bignumber.toString("utf8"),
    ...(decimal ? { decimal: decimal.toString("utf8") } : {}),
    momentTimezone: momentTimezone.toString("utf8"),
    api: api?.toString("utf8"),
    sha256: {
      engine: sha256Hex(engine),
      ...(api ? { api: sha256Hex(api) } : {}),
      bignumber: sha256Hex(bignumber),
      ...(decimal ? { decimal: sha256Hex(decimal) } : {}),
      momentTimezone: sha256Hex(momentTimezone),
      contents: sha256Hex(contents)
    }
  };
}
