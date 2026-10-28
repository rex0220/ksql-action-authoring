// MCP サーバーを 1 ファイルに束ねる（dist/mcp.mjs）。zip のコードは束ねない（利用者の zip から読む）
// 資料（docs/ の Markdown）は __KACT_DOCS__ に埋め込む（Desktop ではツールしか届かないので、資料はツールで渡す）
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const dir = path.join(root, "docs");
const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
const docs = {
  source: { commit: gitCommit(root) },
  sections: manifest.sections.map((s) => ({ key: s.key, title: s.title, kind: s.kind, text: readFileSync(path.join(dir, s.file), "utf8") })),
};
console.log(`docs: ${docs.sections.length} 章 ${docs.sections.reduce((n, s) => n + s.text.length, 0).toLocaleString()} 文字`);

await build({
  entryPoints: ["src/mcp.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: "dist/mcp.mjs",
  external: ["happy-dom"],
  define: {
    __KACT_TOOLS_META__: JSON.stringify(JSON.stringify({ toolsVersion: pkg.version, pluginId: "afkekkiffjhdkcepekecalklafjhbcmf", minPluginVersion: 1, supportedApiVersions: [1], commit: gitCommit(root), mode: "build", builtAt: new Date().toISOString() })),
    __KACT_DOCS__: JSON.stringify(JSON.stringify(docs)),
  },
  logLevel: "info",
});
