/**
 * 置き場所の解決。tools/src と tools/dist はどちらも tools/ の 1 つ下なので、import.meta.url から同じ計算で tools/ が出る。
 *   - 計算式エンジンとkSQL アクションの authoring API は利用者のkSQL アクション zip から読む（plugin-zip.ts）。開発中は隣の ksql-action の prod/ からも読める（dev-paths.ts。CLI が渡す）
 *   - moment: vendor/（scripts/vendor.mjs が CDN から取る。kSQL アクションの manifest と同じ 2.24.0）
 * 環境変数は読まない（中核から import してよい）。環境変数で決める開発用の場所は dev-paths.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** tools/ */
export const AUTHORING_ROOT = path.resolve(here, "..");
/** リポジトリ ksql-action-authoring のルート（テンプレートの置き場所） */
export const REPO_ROOT = path.resolve(AUTHORING_ROOT, "..");
export const VENDOR_DIR = path.join(AUTHORING_ROOT, "vendor");
export const MOMENT_URL = "https://js.cybozu.com/momentjs/2.24.0/moment-with-locales.min.js";
export const MOMENT_FILE = path.join(VENDOR_DIR, "moment-with-locales.min.js");
