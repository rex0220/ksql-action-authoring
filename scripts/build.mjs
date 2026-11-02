// MCP サーバーを 1 ファイルに束ねる（dist/mcp.mjs）。zip のコードは束ねない（利用者の zip から読む）
// 資料（docs/ の Markdown）は __KACT_DOCS__ に埋め込む（Desktop ではツールしか届かないので、資料はツールで渡す）
// 配布（段階 5）のための検査も、ここでまとめて行う:
//   - src/ と node_modules/ の外のファイル、kSQL アクション / kit / rexgrid のコードが混ざっていないか
//   - happy-dom を束ねたか（配布物は 1 ファイルで動かす）
//   - 互換表（compat.json）の版が package.json・plugin.json とそろっているか
//   - 束ねた依存の著作権表示（THIRD_PARTY_NOTICES.md）がリポジトリのものと同じか（違えば止める。--write-notices で書き直す）
// 使い方: node scripts/build.mjs [--write-notices]
import { build } from "esbuild";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundledPackages, eol, NOTICES_FILE, renderNotices, vendorMoment } from "./third-party-notices.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

function gitCommit(dir) {
  try {
    const head = execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["-C", dir, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() !== "";
    return dirty ? `${head}+dirty` : head;
  } catch {
    return "unknown";
  }
}

/**
 * 埋め込む日時は**コミットの日時**にする（ビルドした時刻を入れない）。
 * 同じコミットから作れば配布物のバイト列が同じになり、sha256 で固定して配れる（formula MCP と同じ性質）
 */
function commitTime(dir) {
  try {
    return execFileSync("git", ["-C", dir, "log", "-1", "--format=%cI"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const dir = path.join(root, "docs");
const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
const docs = {
  source: { commit: gitCommit(root) },
  sections: manifest.sections.map((s) => ({ key: s.key, title: s.title, kind: s.kind, text: readFileSync(path.join(dir, s.file), "utf8") })),
};
console.log(`docs: ${docs.sections.length} 章 ${docs.sections.reduce((n, s) => n + s.text.length, 0).toLocaleString()} 文字`);

/**
 * 埋め込む meta は **src/meta.ts から読む**（書き写すと食い違う。2026-10-31 に
 * `supportedApiVersions` が [1] のまま残って、API の版 2 の zip を MCP が拒んだ）
 */
function metaFromSource() {
  const text = readFileSync(path.join(root, "src/meta.ts"), "utf8");
  const pick = (name) => {
    const m = text.match(new RegExp(`export const ${name}[^=]*=\\s*([^;]+);`));
    if (!m) throw new Error(`src/meta.ts から ${name} を読めない`);
    return m[1].trim();
  };
  const pluginId = pick("KSQL_ACTION_PLUGIN_ID").replace(/^"|"$/g, "");
  const minPluginVersion = Number(pick("MIN_PLUGIN_VERSION"));
  const supportedApiVersions = JSON.parse(pick("SUPPORTED_API_VERSIONS"));
  if (!/^[a-z]{32}$/.test(pluginId) || !Number.isInteger(minPluginVersion) || !Array.isArray(supportedApiVersions)) {
    throw new Error("src/meta.ts の値の形が変わっている（build.mjs の metaFromSource を直す）");
  }
  return { pluginId, minPluginVersion, supportedApiVersions };
}

const result = await build({
  entryPoints: ["src/mcp.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: "dist/mcp.mjs",
  charset: "utf8",
  legalComments: "eof",
  // happy-dom も束ねる（配布物は 1 ファイルで動かす。node_modules を配らない）。
  // この 2 つは happy-dom の中の ws が任意で読む native の加速で、無くても動く
  external: ["bufferutil", "utf-8-validate"],
  // 束ねた CJS の依存が Node の組み込みを require するので、ESM でも require を使えるようにする（formula MCP と同じ）
  banner: {
    js: `/*! kSQL アクションのオーサリング（kact MCP）${pkg.version}。MIT License. kSQL のエンジン・計算式エンジン・プラグインの検査は利用者の kSQL アクションの zip から読む（このファイルには含まれない） */\nimport { createRequire as __kact_createRequire } from "node:module"; const require = __kact_createRequire(import.meta.url);`,
  },
  define: {
    __KACT_TOOLS_META__: JSON.stringify(JSON.stringify({ toolsVersion: pkg.version, ...metaFromSource(), commit: gitCommit(root), mode: "build", builtAt: commitTime(root) })),
    __KACT_DOCS__: JSON.stringify(JSON.stringify(docs)),
  },
  metafile: true,
  logLevel: "info",
});

// 束ねたものは src/ と node_modules/ だけから作る（有償プラグインのコードを入れない。formula MCP と同じ検査）
const inputs = Object.keys(result.metafile.inputs).map((p) => p.replace(/\\/g, "/"));
const outside = inputs.filter((p) => !/^(src|node_modules)\//.test(p));
if (outside.length) throw new Error(`src/ と node_modules/ の外のファイルが束ねられている:\n  ${outside.join("\n  ")}`);
const leaked = inputs.filter((p) => /ksql-action\/(src|lib|prod)\/|plugin-config-kit\/src|rexgrid\/src/.test(p));
if (leaked.length) throw new Error(`kSQL アクション / kit / rexgrid のコードが入っている:\n  ${leaked.join("\n  ")}`);
const js = readFileSync(path.join(root, "dist/mcp.mjs"), "utf8");
for (const re of [/require\(["']@modelcontextprotocol\//, /require\(["']zod(?:\/[^"']*)?["']\)/, /require\(["']happy-dom/, /\bfrom\s*["']happy-dom["']/]) {
  if (re.test(js)) throw new Error(`束ねていない依存が残っている: ${re}`);
}
console.log(`bundle: ${inputs.length} ファイル（happy-dom ${inputs.filter((p) => p.includes("happy-dom")).length}）`);

// 互換表（compat.json）: 版が package.json と plugin.json とそろっているか。対応する API の版は src/meta.ts が正本
const compat = JSON.parse(readFileSync(path.join(root, "compat.json"), "utf8"));
const plugin = JSON.parse(readFileSync(path.join(root, ".claude-plugin/plugin.json"), "utf8"));
const meta = metaFromSource();
const checks = compat.runtimeChecks ?? {};
if (checks.mcpVersion !== pkg.version || plugin.version !== pkg.version) {
  throw new Error(`版がそろっていない: package.json ${pkg.version}、plugin.json ${plugin.version}、compat.json ${checks.mcpVersion}`);
}
if (JSON.stringify(checks.authoringApiVersions) !== JSON.stringify(meta.supportedApiVersions)) {
  throw new Error(`compat.json の authoringApiVersions が src/meta.ts の SUPPORTED_API_VERSIONS と違う: ${JSON.stringify(checks.authoringApiVersions)} ≠ ${JSON.stringify(meta.supportedApiVersions)}`);
}
if (checks.pluginVersion?.min !== meta.minPluginVersion) {
  throw new Error(`compat.json の pluginVersion.min が src/meta.ts の MIN_PLUGIN_VERSION と違う: ${checks.pluginVersion?.min} ≠ ${meta.minPluginVersion}`);
}

// 束ねた依存の著作権表示（配布物に入れる。vendor/ の moment も載せる）
const notices = renderNotices(
  bundledPackages(root, [{ label: "本体", metafile: result.metafile }]),
  vendorMoment(path.join(root, "vendor", "moment.json")),
);
const noticesPath = path.join(root, NOTICES_FILE);
if (process.argv.includes("--write-notices")) {
  writeFileSync(noticesPath, notices);
  console.log(`${NOTICES_FILE} を書き直した`);
} else if (!existsSync(noticesPath) || eol(readFileSync(noticesPath, "utf8")) !== notices) {
  throw new Error(`${NOTICES_FILE} が束ねた依存と合わない（npm run notices で作り直し、差分を確かめてコミットする）`);
}
