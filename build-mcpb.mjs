// 束ねた kact（dist/mcp.mjs）を Claude Desktop の .mcpb にする。
// **formula MCP の build-mcpb.mjs からの写し**（あちらが正本。kact は本体が 1 ファイルなので server/ が 1 つだけ）。
//   - manifest は package.json から（名前・版）。ツールの一覧は束ねた本体の tools/list と同じ（scripts/mcpb-verify.mjs が照合する）
//   - 設定項目: 作業フォルダー（directory、必須）、kSQL アクションプラグインの zip（file、必須）、kintone の接続のファイル（file、任意）
//   - 設定の値は引数でなく環境変数で渡す（mcp_config.env。kact は KACT_WORKSPACE / KACT_PLUGIN_ZIP / KACT_KINTONE_CONFIG を読む）
//   - 配布元・プライバシーポリシー（privacy_policies。kintone に接続するので要る）、束ねた依存の著作権表示（THIRD_PARTY_NOTICES.md）
//   - 入れてはいけないもの（scripts/forbidden-files.mjs）があれば作らない
//   - vendor/ は server/ の隣に置く（src/paths.ts が「本体の 1 つ上の vendor/」を見る）
// 使い方: npm run build && node build-mcpb.mjs  → dist-mcpb/ksql-action.mcpb
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { problemsOf } from "./scripts/forbidden-files.mjs";
import { NOTICES_FILE } from "./scripts/third-party-notices.mjs";
import { createZip } from "./scripts/zip.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const outDir = join(root, "dist-mcpb");
export const outPath = join(outDir, "ksql-action.mcpb");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** 配布元（GitHub のリポジトリ） */
export const REPO_URL = "https://github.com/rex0220/ksql-action-authoring";

/** Desktop の拡張機能の画面に出すツールの一覧（短い説明。AI に渡る説明は本体の tools/list） */
export const MANIFEST_TOOLS = [
  ["kact_docs", "kSQL アクションの設定づくりの手順と資料（最初に呼ぶ）"],
  ["kact_status", "環境の診断（作業フォルダー、プラグインの zip、接続）"],
  ["kact_workspace_status", "作業フォルダーの診断（設定ファイルと項目定義の控え）"],
  ["kact_check", "設定の検査（設定画面の保存と同じ規則。書き換えない）"],
  ["kact_explain", "アクションの SQL の実行計画（kintone には行かない）"],
  ["kact_actions", "設定のアクションの一覧（SQL 本文は返さない）"],
  ["kact_files", "作業フォルダーの設定ファイルの一覧と digest"],
  ["kact_fields", "kintone の項目定義を取る（GET だけ。控えを置く）"],
  ["kact_try", "式の試し計算（架空の値で評価。値・条件の真偽・注入される文字列）"],
  ["kact_views", "kintone の一覧（ビュー）の ID・名前・種類（GET だけ）"],
  ["kact_apps", "kintone のアプリの一覧（GET だけ）"],
  ["kact_save_config", "新しい設定を検査して保存（上書きしない）"],
  ["kact_update_action", "既存の設定のアクションを差し替える・足す"],
  ["kact_delete_action", "既存の設定のアクションを消す"],
  ["kact_pull", "設定画面でダウンロードした設定を取り込む"],
  ["kact_diff", "2 つの設定の差（SQL は行の差分）"],
];

export const manifest = {
  manifest_version: "0.3",
  name: "ksql-action-authoring",
  display_name: "kSQL アクション 設定オーサリング",
  version: pkg.version,
  description: "kintone の kSQL アクションプラグイン（rex0220 kSQL Action）の設定 JSON を、検査と実行計画を通して作業フォルダーに保存・確認する。kintone には読み取り（GET）だけ",
  author: { name: "rex0220" },
  license: "MIT",
  homepage: REPO_URL,
  repository: { type: "git", url: REPO_URL },
  support: `${REPO_URL}/issues`,
  privacy_policies: [`${REPO_URL}/blob/main/PRIVACY.md`],
  server: {
    type: "node",
    entry_point: "server/mcp.mjs",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/mcp.mjs", "--surface", "desktop"],
      env: {
        KACT_WORKSPACE: "${user_config.workspaceDir}",
        KACT_PLUGIN_ZIP: "${user_config.pluginZip}",
        KACT_KINTONE_CONFIG: "${user_config.kintoneConfig}",
      },
    },
  },
  tools: MANIFEST_TOOLS.map(([name, description]) => ({ name, description })),
  tools_generated: false,
  keywords: ["kintone", "ksql", "kSQLアクション", "mcp"],
  compatibility: {
    claude_desktop: ">=0.10.0",
    platforms: ["darwin", "win32"],
    runtimes: { node: ">=20.0.0" },
  },
  user_config: {
    workspaceDir: {
      type: "directory",
      title: "作業フォルダー",
      description: "kSQL アクションの設定ファイルと、kintone の項目定義の控えを置くフォルダー",
      required: true,
    },
    pluginZip: {
      type: "file",
      title: "kSQL アクションプラグインの zip",
      description: "アプリに入れた kSQL アクションプラグイン（Ver.1 以降。試用版でよい）の zip（配布元から入手したもの。同じ版）",
      required: true,
    },
    kintoneConfig: {
      type: "file",
      title: "kintone の接続のファイル",
      description: "kSQL の ksql.config.json と同じ形のファイル（接続先と、アプリごとの閲覧だけの API トークン。作業フォルダーの外に置く。kSQL と同じファイルでもよい）。無ければ kintone を使うツールは使えない",
      required: false,
    },
  },
};

const readme = `# kSQL アクション 設定オーサリング ${pkg.version}

kintone の kSQL アクションプラグイン（rex0220 kSQL Action。Ver.1 以降）の設定 JSON を、検査と実行計画を通して作業フォルダーに保存・確認する Claude Desktop の拡張機能。
チャットで「kSQL アクションで〜」と頼む（最初に kact_docs が手順を返す）。kintone には読み取り（GET）だけ。秘密の値・SQL 本文・レコードの値は応答・ログに出さない。
設定の取り込みと実行は利用者が kintone の画面で行う（この拡張機能は書き込まない）。
同梱の依存（MCP の SDK、zod、happy-dom など）の著作権表示とライセンスは THIRD_PARTY_NOTICES.md にある。
プライバシーポリシー、セキュリティ、変更履歴: ${REPO_URL}
`;

function files() {
  return [
    { path: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") },
    { path: "server/mcp.mjs", data: readFileSync(join(dist, "mcp.mjs")) },
    { path: "vendor/moment-with-locales.min.js", data: readFileSync(join(root, "vendor", "moment-with-locales.min.js")) },
    { path: "vendor/moment.json", data: readFileSync(join(root, "vendor", "moment.json")) },
    { path: "LICENSE", data: readFileSync(join(root, "LICENSE")) },
    { path: NOTICES_FILE, data: readFileSync(join(root, NOTICES_FILE)) },
    { path: "README.md", data: Buffer.from(readme, "utf8") },
  ];
}

function isIgnored() {
  const p = join(root, ".gitignore");
  return existsSync(p) && readFileSync(p, "utf8").split(/\r?\n/).some((l) => ["dist-mcpb/", "*.mcpb"].includes(l.trim()));
}

// ---- 実行 ----
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!isIgnored()) throw new Error(".gitignore に dist-mcpb/ と *.mcpb が無い（成果物をコミットしない）");
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const entries = files();
  const problems = problemsOf(entries.map((e) => [e.path, e.data]));
  if (problems.length) throw new Error(`入れてはいけないもの:\n  ${problems.join("\n  ")}`);
  const zip = createZip(entries);
  writeFileSync(outPath, zip);
  console.log(`[build-mcpb] ${outPath} (${zip.length.toLocaleString()} bytes; 版 ${pkg.version})`);
}
