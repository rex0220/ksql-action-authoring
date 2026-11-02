// .mcpb の検査。**formula MCP の scripts/mcpb-verify.mjs からの写し**（あちらが正本。kact は本体が 1 ファイルで、MCP の SDK は v1）。
//   1. zip を開いて、要るファイル・入れてはいけないもの（scripts/forbidden-files.mjs）・manifest の値（版、起動の形、設定項目の種類、
//      秘密の値は env で渡すこと、配布元とプライバシーポリシー）、THIRD_PARTY_NOTICES.md がリポジトリのものと同じこと
//   2. 展開して、Desktop と同じ形（node server/mcp.mjs + 引数 + 環境変数、起動の場所はドライブのいちばん上）で起動し、MCP のクライアントで話す:
//      指示に製品の名前、ツールの一覧が manifest と同じ、kact_docs の目次、kact_status（zip を読めて互換）、保存の ok / conflict / denied、
//      kintone の接続のファイル（作業フォルダーの外）に書いた試験用の API トークンが引数・応答・標準エラーに出ないこと
// 使い方: npm run build && node build-mcpb.mjs && node scripts/mcpb-verify.mjs
//   （kSQL アクションプラグインの zip は KACT_TEST_PLUGIN_ZIP か、隣の ksql-action の dist/ksql-action-plugin1.zip）
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { REPO_URL } from "../build-mcpb.mjs";
import { problemsOf } from "./forbidden-files.mjs";
import { eol, NOTICES_FILE } from "./third-party-notices.mjs";
import { readZip } from "./zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpbPath = path.join(root, "dist-mcpb", "ksql-action.mcpb");
const tmp = path.join(root, ".tmp", "mcpb-verify");
const ZIP = process.env.KACT_TEST_PLUGIN_ZIP ?? path.resolve(root, "../ksql-action/dist/ksql-action-plugin1.zip");
const TEST_TOKEN = "TEST-not-a-real-token-0123456789"; // 本物の資格情報は使わない

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function main() {
  assert(existsSync(ZIP), `kSQL アクションプラグインの zip が無い: ${ZIP}（KACT_TEST_PLUGIN_ZIP で指す）`);
  const entries = readZip(mcpbPath);
  const expected = ["manifest.json", "server/mcp.mjs", "vendor/moment-with-locales.min.js", "vendor/moment.json", "LICENSE", NOTICES_FILE, "README.md"];
  assert(JSON.stringify([...entries.keys()].sort()) === JSON.stringify([...expected].sort()), `中身が違う: ${[...entries.keys()].join(", ")}`);
  const problems = problemsOf(entries);
  assert(!problems.length, `入れてはいけないもの:\n  ${problems.join("\n  ")}`);
  assert(eol(entries.get(NOTICES_FILE).toString("utf8")) === eol(readFileSync(path.join(root, NOTICES_FILE), "utf8")), `${NOTICES_FILE} がリポジトリのものと違う`);

  const manifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert(manifest.manifest_version === "0.3", "manifest_version");
  assert(manifest.version === pkg.version, "manifest の版が package.json と違う");
  assert(manifest.server?.type === "node" && manifest.server.entry_point === "server/mcp.mjs", "server の形");
  assert(manifest.server.mcp_config.args[0] === "${__dirname}/server/mcp.mjs", "起動のファイル");
  assert(!manifest.server.mcp_config.args.some((a) => /kintoneConfig|pluginZip|workspaceDir/.test(a)), "zip・接続のファイル・作業フォルダーを引数に入れない（env で渡す）");
  assert(manifest.server.mcp_config.env?.KACT_KINTONE_CONFIG === "${user_config.kintoneConfig}", "接続のファイルは env で渡す");
  assert(!Object.keys(manifest.server.mcp_config.env).some((k) => /^KINTONE_/.test(k)), "kintone の URL・トークンを設定項目で渡さない（接続のファイルだけ）");
  assert(manifest.user_config.workspaceDir?.type === "directory" && manifest.user_config.workspaceDir.required === true, "workspaceDir は必須のフォルダー");
  assert(manifest.user_config.pluginZip?.type === "file" && manifest.user_config.pluginZip.required === true, "pluginZip は必須のファイル");
  // 接続のファイルは任意（無ければ kintone を使わないツールだけが動く）
  assert(manifest.user_config.kintoneConfig?.type === "file" && manifest.user_config.kintoneConfig.required === false, "kintoneConfig は任意のファイル");
  assert(JSON.stringify(Object.keys(manifest.user_config).sort()) === JSON.stringify(["kintoneConfig", "pluginZip", "workspaceDir"]), "設定項目は作業フォルダー・zip・接続のファイルだけ");
  for (const [k, v] of Object.entries(manifest.user_config)) assert((v.sensitive === true) === /token|password|username/i.test(k), `${k} の sensitive（秘密の値の項目だけ）`);
  const plugin = JSON.parse(readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
  for (const [k, v] of Object.entries(plugin.userConfig)) assert((v.sensitive === true) === /token|password|username/i.test(k), `プラグインの ${k} の sensitive（秘密の値の項目だけ）`);
  assert(JSON.stringify(manifest.compatibility?.platforms) === JSON.stringify(["darwin", "win32"]), "platforms");
  // 配布元とプライバシーポリシー（kintone に接続するので要る。リリース手順 0-5・0-8）
  assert(manifest.homepage === REPO_URL && manifest.repository?.type === "git" && manifest.repository.url === REPO_URL && manifest.support === `${REPO_URL}/issues`, "配布元（homepage、repository、support）");
  assert(JSON.stringify(manifest.privacy_policies) === JSON.stringify([`${REPO_URL}/blob/main/PRIVACY.md`]) && existsSync(path.join(root, "PRIVACY.md")), "privacy_policies は PRIVACY.md の https の URL");
  const bundle = entries.get("server/mcp.mjs").toString("utf8");
  assert(!/require\(["'](@modelcontextprotocol\/|zod|happy-dom)/.test(bundle) && !/\bfrom\s*["']happy-dom["']/.test(bundle), "依存を束ねていない");

  rmSync(tmp, { recursive: true, force: true });
  const bundleDir = path.join(tmp, "bundle");
  for (const [p, data] of entries) {
    mkdirSync(path.dirname(path.join(bundleDir, p)), { recursive: true });
    writeFileSync(path.join(bundleDir, p), data);
  }
  // 作業フォルダー（Desktop の設定項目で選ぶので、あるフォルダーを渡す）
  const workspace = path.join(realpathSync(tmp), "workspace");
  mkdirSync(workspace, { recursive: true });
  // kintone の接続のファイル（作業フォルダーの外。kSQL の形。トークンを直接書いた試験の値）
  const connFile = path.join(realpathSync(tmp), "ksql.config.json");
  writeFileSync(connFile, JSON.stringify({ defaultProfile: "dev", profiles: { dev: { baseUrl: "https://x.cybozu.com", tokenMap: { APP1001: TEST_TOKEN } } } }), { mode: 0o600 });
  const argv = manifest.server.mcp_config.args.map((a) => a.replace("${__dirname}", bundleDir));
  const env = { PATH: process.env.PATH ?? "" };
  for (const [k, v] of Object.entries(manifest.server.mcp_config.env)) {
    env[k] = v.replace("${user_config.pluginZip}", ZIP).replace("${user_config.kintoneConfig}", connFile).replace("${user_config.workspaceDir}", workspace);
  }
  const transport = new StdioClientTransport({ command: process.execPath, args: argv, env, cwd: path.parse(process.cwd()).root, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  const client = new Client({ name: "mcpb-verify", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  const seen = [];
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    seen.push(JSON.stringify(r));
    return r;
  };
  const resultOf = (r) => JSON.parse(r.content.map((c) => c.text).join(""));
  try {
    const instructions = client.getInstructions?.();
    assert(/kSQL アクション/.test(String(instructions)) && /kintone への書き込みは行わない/.test(String(instructions)), `指示に製品の名前と約束: ${String(instructions).slice(0, 80)}`);
    const { tools } = await client.listTools();
    assert(JSON.stringify(tools.map((t) => t.name)) === JSON.stringify(manifest.tools.map((t) => t.name)), `ツールの一覧が manifest と違う: ${tools.map((t) => t.name).join(", ")}`);
    const docs = (await call("kact_docs", {})).content.map((c) => c.text).join("\n");
    assert(/kact/.test(docs) && /section/.test(docs), "kact_docs は目次（章の一覧）を返す");
    const st = resultOf(await call("kact_status", {}));
    assert(st.status === "ok", `kact_status が ok（zip を読めて互換）: ${JSON.stringify(st.findings ?? [])}`);
    assert(st.plugin?.apiVersion >= 1 && st.tools?.supportedApiVersions?.includes(st.plugin.apiVersion), `API の版が対応の範囲: ${JSON.stringify(st.plugin)}`);
    assert(!JSON.stringify(st).includes(workspace) && !JSON.stringify(st).includes(ZIP) && !JSON.stringify(st).includes(connFile), "診断は絶対パスを返さない");
    const config = JSON.parse(readFileSync(path.join(root, "test", "fixtures", "config.json"), "utf8"));
    const input = { file: "settings/kact-1001.json", appId: 1001, appName: "受注", config };
    const ok = resultOf(await call("kact_save_config", input));
    assert(ok.status === "ok" && existsSync(path.join(workspace, input.file)), `保存できる（settings/ が無い作業フォルダー）: ${JSON.stringify(ok)}`);
    assert(resultOf(await call("kact_save_config", input)).status === "conflict", "同じ名前は conflict");
    assert(resultOf(await call("kact_save_config", { ...input, file: "../x.json" })).status === "denied", "作業フォルダーの外は denied");
  } finally {
    await client.close();
  }
  assert(!argv.some((a) => a.includes(TEST_TOKEN)) && !Object.values(env).some((v) => v.includes(TEST_TOKEN)), "引数と環境変数にトークンが無い（接続のファイルだけ）");
  assert(!seen.join("\n").includes(TEST_TOKEN), "応答にトークンが出ない");
  assert(!stderr.includes(TEST_TOKEN), "標準エラーにトークンが出ない");
  assert(!stderr.includes(connFile), "標準エラーに接続のファイルのパスが出ない");
  console.log(`[mcpb-verify] ok（${path.basename(mcpbPath)} ${manifest.version}、ツール ${manifest.tools.length}、node ${process.version} で起動。Desktop の Node の版は手で確かめる）`);
}

main().catch((e) => {
  console.error(`[mcpb-verify] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
