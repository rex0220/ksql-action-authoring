// プラグインの zip の検査（mcpb-verify.mjs の Claude Code 版）。
// **formula MCP の scripts/plugin-zip-verify.mjs からの写し**（あちらが正本。kact は本体が 1 ファイルで、MCP の SDK は v1）。
//   1. zip を開いて、中身の一覧（決まったファイルだけ）、入れてはいけないもの、版（plugin.json と package.json）、THIRD_PARTY_NOTICES.md がリポジトリと同じ、
//      .mcp.json が zip の中の本体を指し、プラグインの zip と接続のファイルを env で渡す、hooks.json のモジュールが zip にある
//   2. 展開して、Claude Code と同じ形（.mcp.json の command と args。${CLAUDE_PLUGIN_ROOT} は展開したフォルダー）で起動し、MCP のクライアントで話す:
//      ツールの一覧、kact_status、保存（zip の中の本体と vendor/ の moment で検査が通る）、試験用の API トークンが応答・標準エラーに出ないこと
//   3. claude があれば claude plugin validate（展開したフォルダー。CLAUDE=<claude の実行ファイル> で指定できる）
//   4. sha256 と、marketplace.json の archive の項目（scripts/write-marketplace.mjs が書く）を出す
// 使い方: npm run build && node scripts/build-plugin-zip.mjs && node scripts/plugin-zip-verify.mjs
//   （kSQL アクションプラグインの zip は KACT_TEST_PLUGIN_ZIP か、隣の ksql-action の dist/ksql-action-plugin1.zip）
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MARKETPLACE_NAME, outPath, PLUGIN_FILES, PLUGIN_NAME, zipName } from "./build-plugin-zip.mjs";
import { problemsOf } from "./forbidden-files.mjs";
import { eol, NOTICES_FILE } from "./third-party-notices.mjs";
import { readZip } from "./zip.mjs";
import { archiveSource } from "./write-marketplace.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, ".tmp", "plugin-zip-verify");
const ZIP = process.env.KACT_TEST_PLUGIN_ZIP ?? path.resolve(root, "../ksql-action/dist/ksql-action-plugin1.zip");
const TEST_TOKEN = "TEST-not-a-real-token-0123456789"; // 本物の資格情報は使わない

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function main() {
  assert(existsSync(ZIP), `kSQL アクションプラグインの zip が無い: ${ZIP}（KACT_TEST_PLUGIN_ZIP で指す）`);
  const entries = readZip(outPath);
  const expected = [...PLUGIN_FILES.map(([p]) => p), "README.md"];
  assert(JSON.stringify([...entries.keys()].sort()) === JSON.stringify([...expected].sort()), `中身が違う: ${[...entries.keys()].join(", ")}`);
  const problems = problemsOf(entries);
  assert(!problems.length, `入れてはいけないもの:\n  ${problems.join("\n  ")}`);
  assert(eol(entries.get(NOTICES_FILE).toString("utf8")) === eol(readFileSync(path.join(root, NOTICES_FILE), "utf8")), `${NOTICES_FILE} がリポジトリのものと違う`);

  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const plugin = JSON.parse(entries.get(".claude-plugin/plugin.json").toString("utf8"));
  assert(plugin.name === PLUGIN_NAME && plugin.version === pkg.version, `plugin.json の名前・版: ${plugin.name} ${plugin.version}`);
  assert(path.basename(outPath) === zipName(plugin.version), "zip の名前に版");
  for (const [k, v] of Object.entries(plugin.userConfig)) assert((v.sensitive === true) === /token|password|username/i.test(k), `プラグインの ${k} の sensitive（秘密の値の項目だけ）`);
  const server = JSON.parse(entries.get(".mcp.json").toString("utf8")).mcpServers?.[PLUGIN_NAME];
  assert(server?.command === "node" && server.args[0] === "${CLAUDE_PLUGIN_ROOT}/dist/mcp.mjs" && entries.has("dist/mcp.mjs"), ".mcp.json が zip の中の本体を指す");
  assert(server.env?.KACT_PLUGIN_ZIP === "${user_config.pluginZip}" && server.env?.KACT_KINTONE_CONFIG === "${user_config.kintoneConfig}", "プラグインの zip と接続のファイルは env で渡す");
  assert(!server.args.some((a) => /pluginZip|kintoneConfig|workspace/.test(a)), "zip・接続のファイル・作業フォルダーを引数に入れない");
  const hooks = JSON.parse(entries.get("hooks/hooks.json").toString("utf8"));
  assert(Array.isArray(hooks.modules) && hooks.modules.every((m) => entries.has(path.posix.join("hooks", m))), "hooks.json のモジュールが zip にある");
  assert(!entries.has("package.json") && ![...entries.keys()].some((p) => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|bun\.lock)$/.test(p)), "package.json と lockfile は入れない（依存を入れさせない）");

  rmSync(tmp, { recursive: true, force: true });
  const pluginDir = path.join(tmp, "plugin");
  for (const [p, data] of entries) {
    mkdirSync(path.dirname(path.join(pluginDir, p)), { recursive: true });
    writeFileSync(path.join(pluginDir, p), data);
  }
  const workspace = path.join(realpathSync(tmp), "workspace");
  mkdirSync(workspace, { recursive: true });
  const connFile = path.join(realpathSync(tmp), "ksql.config.json");
  writeFileSync(connFile, JSON.stringify({ defaultProfile: "dev", profiles: { dev: { baseUrl: "https://x.cybozu.com", tokenMap: { APP1001: TEST_TOKEN } } } }), { mode: 0o600 });
  const values = { "${CLAUDE_PLUGIN_ROOT}": pluginDir, "${user_config.workspace}": workspace, "${user_config.pluginZip}": ZIP, "${user_config.kintoneConfig}": connFile };
  const fill = (s) => Object.entries(values).reduce((acc, [k, v]) => acc.replaceAll(k, v), s);
  const argv = server.args.map(fill);
  const env = { PATH: process.env.PATH ?? "", CLAUDE_PLUGIN_ROOT: pluginDir };
  for (const [k, v] of Object.entries(server.env)) env[k] = fill(v);
  const transport = new StdioClientTransport({ command: process.execPath, args: argv, env, cwd: path.parse(process.cwd()).root, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  const client = new Client({ name: "plugin-zip-verify", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  const seen = [];
  let toolCount = 0;
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    seen.push(JSON.stringify(r));
    return r;
  };
  const resultOf = (r) => JSON.parse(r.content.map((c) => c.text).join(""));
  try {
    const instructions = client.getInstructions?.();
    assert(/kSQL アクション/.test(String(instructions)), `指示に製品の名前: ${String(instructions).slice(0, 80)}`);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    toolCount = names.length;
    assert(names.includes("kact_save_config") && names.includes("kact_status") && names.includes("kact_explain"), `Claude Code のツールの一覧: ${names.join(", ")}`);
    const st = resultOf(await call("kact_status", {}));
    assert(st.status === "ok" && st.surface === "claude-code", `準備ができた（surface と zip）: ${JSON.stringify(st.findings ?? [])}`);
    assert(st.plugin?.apiVersion >= 1 && st.tools?.supportedApiVersions?.includes(st.plugin.apiVersion), `API の版が対応の範囲: ${JSON.stringify(st.plugin)}`);
    const config = JSON.parse(readFileSync(path.join(root, "test", "fixtures", "config.json"), "utf8"));
    const input = { file: "settings/kact-1001.json", appId: 1001, appName: "受注", config };
    const saved = resultOf(await call("kact_save_config", input));
    assert(saved.status === "ok" && existsSync(path.join(workspace, input.file)), `保存できる（zip の中の本体と vendor/ で検査が通る）: ${JSON.stringify(saved)}`);
  } finally {
    await client.close();
  }
  assert(!seen.join("\n").includes(TEST_TOKEN) && !stderr.includes(TEST_TOKEN), "応答と標準エラーにトークンが出ない");

  // claude plugin validate（claude が無ければ飛ばす）
  const claude = process.env.CLAUDE ?? "claude";
  const v = spawnSync(claude, ["plugin", "validate", pluginDir], { encoding: "utf8" });
  if (v.error?.code === "ENOENT") console.log(`[plugin-zip-verify] claude が無いので plugin validate は飛ばした（CLAUDE=<claude の実行ファイル> で指定できる）`);
  else assert(v.status === 0, `claude plugin validate が通らない:\n${v.stdout}${v.stderr}`);

  const zip = readFileSync(outPath);
  const sha256 = createHash("sha256").update(zip).digest("hex");
  console.log(`[plugin-zip-verify] ok（${path.basename(outPath)} ${plugin.version}、${zip.length.toLocaleString()} bytes、ツール ${toolCount}、node ${process.version} で起動${v.error ? "" : "、claude plugin validate 済み"}）`);
  console.log(`sha256 ${sha256}`);
  console.log(`marketplace（${MARKETPLACE_NAME}）の source: ${JSON.stringify(archiveSource(plugin.version, sha256))}`);
}

main().catch((e) => {
  console.error(`[plugin-zip-verify] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
