// Claude Code のプラグインの zip: GitHub のリリースに置き、marketplace の archive が sha256 で固定して指す。
// **formula MCP の scripts/build-plugin-zip.mjs からの写し**（あちらが正本。kact は本体が 1 ファイル）。
//   - 中身はプラグインに要るものだけ: .claude-plugin/plugin.json、.mcp.json、hooks/（試験と tsconfig を除く）、dist/mcp.mjs、
//     vendor/、LICENSE、THIRD_PARTY_NOTICES.md、短い README。プラグインの root は zip のいちばん上
//   - package.json と lockfile は入れない（Claude Code が依存を入れようとしない。本体は束ねてある）
//   - 名前は kSQL アクションプラグインの zip（ksql-action-plugin1.zip）と混ざらないようにする
//   - 入れてはいけないもの（scripts/forbidden-files.mjs）があれば作らない。版は package.json・plugin.json・compat.json がそろっていること
// 使い方: npm run build && node scripts/build-plugin-zip.mjs → dist-plugin/ksql-action-authoring-plugin-<版>.zip
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_URL } from "../build-mcpb.mjs";
import { problemsOf } from "./forbidden-files.mjs";
import { NOTICES_FILE } from "./third-party-notices.mjs";
import { createZip } from "./zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist-plugin");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const plugin = JSON.parse(readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
const compat = JSON.parse(readFileSync(path.join(root, "compat.json"), "utf8"));

/** marketplace（.claude-plugin/marketplace.json）の名前と、プラグインの名前 */
export const MARKETPLACE_NAME = "rex0220-ksql-action";
export const PLUGIN_NAME = plugin.name;
export const zipName = (version) => `ksql-action-authoring-plugin-${version}.zip`;
export const outPath = path.join(outDir, zipName(pkg.version));

/** zip に入れるファイル（zip の中のパスと、リポジトリの中の元） */
export const PLUGIN_FILES = [
  [".claude-plugin/plugin.json", ".claude-plugin/plugin.json"],
  [".mcp.json", ".mcp.json"],
  ["hooks/hooks.json", "hooks/hooks.json"],
  ["hooks/register.ts", "hooks/register.ts"],
  ["dist/mcp.mjs", "dist/mcp.mjs"],
  ["vendor/moment-with-locales.min.js", "vendor/moment-with-locales.min.js"],
  ["vendor/moment.json", "vendor/moment.json"],
  ["LICENSE", "LICENSE"],
  [NOTICES_FILE, NOTICES_FILE],
];

const readme = `# ${PLUGIN_NAME} ${pkg.version}（Claude Code のプラグイン）

kintone の kSQL アクションプラグイン（rex0220 kSQL Action。Ver.1 以降）の設定 JSON を、検査と実行計画を通して作業フォルダーに保存・確認する Claude Code のプラグイン（kact MCP と、設定ファイルへの直接の書き込みを止めるフック）。kintone には読み取り（GET）だけ。設定の取り込みと実行は利用者が kintone の画面で行う。

- 入れ方: \`/plugin install ${PLUGIN_NAME} --marketplace rex0220/ksql-action-authoring\`（Claude Code 2.1.275 以降。それより前は \`/plugin marketplace add rex0220/ksql-action-authoring\` → \`/plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}\`）
- 設定: \`/config\` で、kSQL アクションプラグインの zip と kintone の接続のファイル
- 使い方、プライバシーポリシー、セキュリティ、変更履歴: ${REPO_URL}
- 同梱の依存の著作権表示とライセンス: ${NOTICES_FILE}
`;

/** zip の中身。版のずれ・ファイルの欠け・入れてはいけないものがあれば止める */
export function pluginEntries() {
  if (plugin.version !== pkg.version || compat.runtimeChecks?.mcpVersion !== pkg.version) {
    throw new Error(`版がそろっていない: package.json ${pkg.version}、plugin.json ${plugin.version}、compat.json ${compat.runtimeChecks?.mcpVersion}`);
  }
  const missing = PLUGIN_FILES.filter(([, from]) => !existsSync(path.join(root, from))).map(([, from]) => from);
  if (missing.length) throw new Error(`無いファイル（先に npm run build）: ${missing.join(", ")}`);
  const entries = [...PLUGIN_FILES.map(([p, from]) => ({ path: p, data: readFileSync(path.join(root, from)) })), { path: "README.md", data: Buffer.from(readme, "utf8") }];
  const problems = problemsOf(entries.map((e) => [e.path, e.data]));
  if (problems.length) throw new Error(`入れてはいけないもの:\n  ${problems.join("\n  ")}`);
  return entries;
}

function isIgnored() {
  const p = path.join(root, ".gitignore");
  return existsSync(p) && readFileSync(p, "utf8").split(/\r?\n/).some((l) => l.trim() === "dist-plugin/");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!isIgnored()) throw new Error(".gitignore に dist-plugin/ が無い（成果物をコミットしない）");
  const zip = createZip(pluginEntries());
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, zip);
  console.log(`[build-plugin-zip] ${outPath} (${zip.length.toLocaleString()} bytes; 版 ${pkg.version})`);
}
