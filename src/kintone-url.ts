/**
 * kintone の接続先 URL の検証（Codex 1-10 レビュー BLOCKER 1）。認証ヘッダー（API トークン / ログインユーザー）を送る先を kintone のドメインだけに限る。
 *   - https で、ユーザー情報（user:pass@）・ポート・パス・クエリ・フラグメントが無い
 *   - ホストは *.cybozu.com / *.kintone.com / *.cybozu.cn（セキュアアクセスの *.s.cybozu.com も含む）
 * 返すのは正規化した origin（小文字、末尾の / 無し）。REST の送信直前にも同じ origin か確かめる（kintone-rest.ts）。
 */
export const KINTONE_HOST_SUFFIXES = [".cybozu.com", ".kintone.com", ".cybozu.cn"] as const;

export class KintoneUrlError extends Error {}

export function normalizeKintoneBaseUrl(raw: string): string {
  const text = String(raw ?? "").trim();
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new KintoneUrlError(`kintone の URL として読めない: ${text.slice(0, 80)}`);
  }
  if (u.protocol !== "https:") throw new KintoneUrlError("kintone の URL は https で始める");
  if (u.username || u.password) throw new KintoneUrlError("kintone の URL にユーザー名やパスワード（@）を入れない");
  if (u.port) throw new KintoneUrlError("kintone の URL にポートを付けない");
  if (u.search || u.hash) throw new KintoneUrlError("kintone の URL にクエリや # を付けない");
  if (u.pathname !== "/" && u.pathname !== "") throw new KintoneUrlError("kintone の URL にパスを付けない（https://<サブドメイン>.cybozu.com だけ）");
  const host = u.hostname.toLowerCase();
  const wellFormed = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host);
  const suffix = KINTONE_HOST_SUFFIXES.find((s) => host.endsWith(s) && host.length > s.length);
  if (!wellFormed || !suffix) {
    throw new KintoneUrlError(`kintone のドメインではない: ${host}（使えるのは ${KINTONE_HOST_SUFFIXES.map((s) => `*${s}`).join(" / ")}）`);
  }
  return `https://${host}`;
}

export function isKintoneBaseUrl(raw: string): boolean {
  try {
    normalizeKintoneBaseUrl(raw);
    return true;
  } catch {
    return false;
  }
}
