/**
 * kintone REST API の読み取り専用クライアント（**印刷屋の tools からの写し**。`src/kintone-rest.ts`。あちらが正本）。
 *   - GET しか送らない（メソッドはここで固定。他のメソッドを送る口が無い）
 *   - 送れるパスは ALLOWED_APIS に固定し、それ以外は送信前に止める（ゲストスペースの /k/guest/<id>/v1/… も同じ一覧）
 *   - 送信先は kintone のドメイン（kintone-url.ts）だけ。URL は new URL(path, base) で組み、送信直前に origin が検証済みの origin と同じか確かめる
 *   - 認証は API トークン（X-Cybozu-API-Token）か、ログインユーザー（X-Cybozu-Authorization）
 *   - エラーの文言は HTTP の状態と kintone のコードと固定のヒントだけ（サーバーの message は出さない。認証情報とレコードの中身を混ぜない）
 *
 * kSQL アクションでは**レコードを読まない**ので、印刷屋の一覧から record / records / layout / plugin/config を外し、
 * アプリの一覧（apps）を足した。設定を作るのに要るのは**項目定義とアプリの名前**だけ（実装計画 5 章）。
 */
import { KintoneUrlError, normalizeKintoneBaseUrl } from "./kintone-url.ts";

/** 認証（接続のファイルから作る。値は決してログ・findings に出さない） */
export interface KintoneAuth {
  baseUrl: string;
  token?: string;
  username?: string;
  password?: string;
}

/** 許可する API（/k/v1/ と /k/guest/<id>/v1/ の後ろ）。ここに無いパスは送信前に止める */
export const ALLOWED_APIS = ["app", "apps", "app/form/fields", "preview/app/form/fields"] as const;

/**
 * 受け取る本文の上限（バイト。印刷屋と同じ考え）。項目が多いアプリ（500 前後、テーブルが多い）でも引っかからない値にする。
 * 超えたら本文を読み切らずに RestError（code LimitError）
 */
export const RECEIVE_LIMITS: Record<(typeof ALLOWED_APIS)[number], number> = {
  app: 64 * 1024,
  apps: 1024 * 1024,
  "app/form/fields": 8 * 1024 * 1024,
  "preview/app/form/fields": 8 * 1024 * 1024
};
export type AllowedApi = (typeof ALLOWED_APIS)[number];

export class RestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly apiPath: string | undefined;
  // Node の型の除去で動かすため、コンストラクターのパラメータープロパティは使わない
  constructor(message: string, status: number, code?: string, apiPath?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.apiPath = apiPath;
  }
}

export class NotAllowedError extends Error {}

/**
 * fetch の応答のうち使う部分。本文はストリーム（body）だけから読む（全文を読んでから大きさを確かめる経路は持たない。Codex レビュー MINOR 8）。
 * body が null なら本文なし。headers は無くてもよい（Content-Length は読む前に止めるためだけ）
 */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
}

export type FetchLike = (url: string, init: { method: "GET"; headers: Record<string, string> }) => Promise<FetchResponseLike>;

/**
 * 上限を守って本文を読む。Content-Length が上限を超えれば読まずに止める。無い・偽りでも、読みながら上限 + 1 バイトで止める。
 * 止めるときの cancel の失敗は無視する（上限の誤りを優先して返す）。JSON にするのは上限の確認の後だけ（呼ぶ側）
 */
export async function readCapped(res: FetchResponseLike, limit: number, apiPath: string): Promise<string> {
  const tooLarge = (): RestError => new RestError(`kintone ${apiPath} の応答が大きすぎる（上限 ${limit} バイト）`, res.status, "LimitError", apiPath);
  const quietCancel = async (reader: { cancel(): Promise<void> }): Promise<void> => {
    try {
      await reader.cancel();
    } catch {
      // 止めるときの失敗は無視
    }
  };
  if (res.body === null) return "";
  if (!res.body || typeof res.body.getReader !== "function") throw new RestError(`kintone ${apiPath} の応答に本文のストリームが無い`, res.status, "ResponseError", apiPath);
  const reader = res.body.getReader();
  const declared = Number(res.headers?.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    await quietCancel(reader);
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > limit) {
      await quietCancel(reader);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

export interface RestClient {
  readonly baseUrl: string;
  /** 許可した API を GET で呼ぶ。api は "app" / "app/form/fields" など。guestSpaceId を渡すとゲストスペースの URL */
  get<T>(api: AllowedApi, params: Record<string, string | number | boolean | undefined>, guestSpaceId?: number): Promise<T>;
}

export function apiPathOf(api: string, guestSpaceId?: number): string {
  if (!(ALLOWED_APIS as readonly string[]).includes(api)) throw new NotAllowedError(`この API は authoring tools では呼ばない: ${api}（許可: ${ALLOWED_APIS.join(", ")}）`);
  if (guestSpaceId !== undefined && (!Number.isInteger(guestSpaceId) || guestSpaceId <= 0)) throw new NotAllowedError(`ゲストスペースの ID が不正: ${String(guestSpaceId)}`);
  const prefix = guestSpaceId ? `/k/guest/${guestSpaceId}/v1/` : "/k/v1/";
  return `${prefix}${api}.json`;
}

export function authHeaders(auth: KintoneAuth): Record<string, string> {
  if (auth.token) return { "X-Cybozu-API-Token": auth.token };
  if (auth.username && auth.password) return { "X-Cybozu-Authorization": Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64") };
  throw new NotAllowedError("認証情報が無い");
}

export function createRestClient(auth: KintoneAuth, fetchImpl: FetchLike = fetch as unknown as FetchLike): RestClient {
  let baseUrl: string;
  try {
    baseUrl = normalizeKintoneBaseUrl(auth.baseUrl);
  } catch (e) {
    throw new NotAllowedError(`接続先が kintone ではないので送らない: ${e instanceof KintoneUrlError ? e.message : String(e)}`);
  }
  const headers = { ...authHeaders(auth), Accept: "application/json" };
  return {
    baseUrl,
    async get<T>(api: AllowedApi, params: Record<string, string | number | boolean | undefined>, guestSpaceId?: number): Promise<T> {
      const apiPath = apiPathOf(api, guestSpaceId);
      const url = new URL(apiPath, baseUrl);
      for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
      if (url.origin !== baseUrl || url.username || url.password) throw new NotAllowedError(`送信先が kintone の接続先と違うので送らない: ${url.origin}`);
      const res = await fetchImpl(url.href, { method: "GET", headers });
      const text = await readCapped(res, RECEIVE_LIMITS[api], apiPath);
      if (!res.ok) {
        let code: string | undefined;
        try {
          const body = JSON.parse(text) as { code?: string };
          code = typeof body.code === "string" ? body.code.slice(0, 40) : undefined;
        } catch {
          // JSON でない応答は無視
        }
        const hint = res.status === 401 ? "（認証情報かアクセス権を確かめる。API トークンならそのアプリで有効か）" : res.status === 403 ? "（アクセス権が無い）" : res.status === 404 ? "（アプリかレコードが無い）" : "";
        throw new RestError(`kintone ${apiPath} が HTTP ${res.status}${code ? ` ${code}` : ""}${hint}`, res.status, code, apiPath);
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new RestError(`kintone ${apiPath} の応答が JSON でない${text ? "" : "（本文が空）"}`, res.status, "ResponseError", apiPath);
      }
    }
  };
}
