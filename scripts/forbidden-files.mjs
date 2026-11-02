// 入れてはいけないもの（リリース手順 0-7、実装案 8.2）: 認証情報、レコードの値、実案件の設定、承認と、本物の kintone の環境のホスト名。
//   リポジトリ（試験 test/forbidden-files.test.mjs）、.mcpb（mcpb-verify）、プラグインの zip（plugin-zip-verify）で同じ決まりを使う
// 使い方: node scripts/forbidden-files.mjs [--history]
//   --history は git の履歴のすべてのコミットも見る（リポジトリを公開する前に 1 回。履歴に残ったものは公開すると誰でも読める）。
//   見るのは手元のブランチ・タグとリモートの追跡ブランチから辿れるコミット（push されるもの）。filter-branch の控え（refs/original）は見ない
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 置いてはいけないパス（/ 区切り。フォルダーはどの深さでも） */
export const FORBIDDEN_PATHS = [
  [/(^|\/)\.env($|\.(?!example$))/, "認証情報（.env）"],
  [/(^|\/)env\//, "認証情報（env/）"],
  [/(^|\/)ksql\.config\.json$/, "kintone の接続のファイル"],
  [/\.(pem|key|p12|pfx)$/i, "鍵"],
  [/(^|\/)records\//, "レコードの値（records/）"],
  [/(^|\/)users\//, "ユーザー情報の実データ（users/）"],
  [/(^|\/)inbox\//, "設定画面のダウンロード（inbox/）"],
  [/(^|\/)kintone\//, "アプリのフォルダー（kintone/。レコードの値と実案件の設定）"],
  [/(^|\/)settings\//, "設定のファイル（settings/。実案件の設定）"],
  [/(^|\/)rex0220-ksql-action-app\d+[^/]*\.json$/, "設定画面のダウンロード（実案件の設定）"],
  [/(^|\/)fields\//, "kintone の項目定義の控え（fields/。kact_fields が置く。ホスト名と実アプリの形）"],
  [/(^|\/)policy\//, "承認（policy/）"]
];

/** 資料と試験の例に使うサブドメインと、kintone の提供元の公開のホスト。これ以外の *.cybozu.com などは本物の環境とみなす */
export const EXAMPLE_SUBDOMAINS = ["x", "y", "dev-x", "xxxxxx", "example", "dev-example", "secret", "other", "js", "www"];

const HOST = /(?<![\w.-])([a-z0-9][a-z0-9-]*)((?:\.[a-z0-9-]+)*)\.(cybozu\.com|cybozu\.cn|kintone\.com|cybozu-dev\.com|kintone-dev\.com)(?![\w-])/gi;
const HOST_ERE = "[A-Za-z0-9.-]+\\.(cybozu\\.com|cybozu\\.cn|kintone\\.com|cybozu-dev\\.com|kintone-dev\\.com)";

/** 本物の環境に見えるホスト名（例のサブドメインでないもの） */
export function realHosts(text) {
  const found = new Set();
  for (const m of text.matchAll(HOST)) if (!EXAMPLE_SUBDOMAINS.includes(m[1].toLowerCase())) found.add(m[0].toLowerCase());
  return [...found].sort();
}

/** パスの決まりに当たる理由 */
export function forbiddenReasons(p) {
  return FORBIDDEN_PATHS.filter(([re]) => re.test(p)).map(([, why]) => why);
}

/** NUL を含まないものを文字とみなす（先頭の 8 KB） */
const isText = (buf) => !buf.subarray(0, 8192).includes(0);

/**
 * ファイルの検査（パスと、文字のファイルの中のホスト名）
 * @param {Iterable<[string, Buffer | (() => Buffer)]>} files パスと中身（関数なら要るときに読む）
 * @returns {string[]} 問題（無ければ空）
 */
export function problemsOf(files) {
  const out = [];
  for (const [p, data] of files) {
    for (const why of forbiddenReasons(p)) out.push(`${p}: ${why}`);
    const buf = typeof data === "function" ? data() : data;
    if (buf && isText(buf)) for (const h of realHosts(buf.toString("utf8"))) out.push(`${p}: 本物の環境に見えるホスト名 ${h}（例の名前にする。例なら scripts/forbidden-files.mjs の EXAMPLE_SUBDOMAINS に足す）`);
  }
  return out;
}

const git = (root, args) => execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** 今の作業ツリーの、git が扱うファイル（コミット済みと、無視されていない新しいファイル） */
export function repoProblems(root) {
  const files = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
  return problemsOf(files.filter((f) => existsSync(path.join(root, f))).map((f) => [f, () => readFileSync(path.join(root, f))]));
}

/** 履歴のコミット（ブランチ・タグ・リモートの追跡ブランチから辿れるもの）のパスとホスト名（公開の前に 1 回）。同じ問題はまとめて、含むコミットの数と最初のコミットを添える */
export function historyProblems(root) {
  const seen = new Map();
  const add = (problem, c) => seen.set(problem, [...(seen.get(problem) ?? []), c.slice(0, 7)]);
  for (const c of git(root, ["rev-list", "--branches", "--tags", "--remotes"]).split("\n").filter(Boolean)) {
    for (const p of git(root, ["ls-tree", "-r", "-z", "--name-only", c]).split("\0").filter(Boolean)) {
      for (const why of forbiddenReasons(p)) add(`${p}: ${why}`, c);
    }
    let lines = "";
    try {
      lines = git(root, ["grep", "-I", "-o", "-E", HOST_ERE, c]);
    } catch (e) {
      if (e.status !== 1) throw e; // 1 は見つからない
    }
    for (const line of new Set(lines.split("\n").filter(Boolean))) {
      const at = line.lastIndexOf(":");
      for (const h of realHosts(line.slice(at + 1))) add(`${line.slice(c.length + 1, at)}: 本物の環境に見えるホスト名 ${h}`, c);
    }
  }
  // rev-list は新しい順なので、最後が最初のコミット
  return [...seen].map(([problem, commits]) => `${problem}（${commits.length} コミット。最初 ${commits.at(-1)}）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const history = process.argv.includes("--history");
  const problems = history ? historyProblems(root) : repoProblems(root);
  if (problems.length) {
    console.error(`[forbidden-files] 入れてはいけないもの（${history ? "履歴" : "作業ツリー"}）:\n  ${problems.join("\n  ")}`);
    process.exitCode = 1;
  } else {
    console.log(`[forbidden-files] ok（${history ? "履歴のすべてのコミット" : "作業ツリー"}）`);
  }
}
