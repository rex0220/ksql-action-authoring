// .claude-plugin/marketplace.json を書く（リリース手順 4-4。GitHub のリリースにプラグインの zip を置いた後）。
// **formula MCP の scripts/write-marketplace.mjs からの写し**（あちらが正本。名前と説明だけ kact に合わせた）。
//   - プラグインの source は archive（GitHub のリリースの zip の URL と sha256）。sha256 は手元の zip から作る（リリースに置いたものと同じ zip）
//   - 版は書かない（plugin.json の版が使われる。両方に書くと食い違いの警告）
//   - archive の source では、入れる前に利用者に見えるのは marketplace の項目だけなので、説明・作者・配布元・ライセンス・キーワードを zip の中の plugin.json から写す
// 使い方: node scripts/write-marketplace.mjs dist-plugin/ksql-action-authoring-plugin-<版>.zip
//   → url は <配布元>/releases/download/v<版>/ksql-action-authoring-plugin-<版>.zip。書いた後に claude plugin validate .
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_URL } from "../build-mcpb.mjs";
import { MARKETPLACE_NAME, zipName } from "./build-plugin-zip.mjs";
import { readZip } from "./zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** GitHub のリリースの zip を指す archive の source */
export function archiveSource(version, sha256) {
  return { source: "archive", url: `${REPO_URL}/releases/download/v${version}/${zipName(version)}`, sha256 };
}

/** marketplace.json の中身 */
export function marketplace(plugin, sha256) {
  const pick = ["description", "author", "homepage", "repository", "license", "keywords"];
  return {
    name: MARKETPLACE_NAME,
    description: "kintone の kSQL アクションプラグイン（rex0220 kSQL Action）の設定を、Claude Code で作る・直す（ksql-action）",
    owner: { name: "rex0220", url: "https://github.com/rex0220" },
    plugins: [
      {
        name: plugin.name,
        ...Object.fromEntries(pick.filter((k) => plugin[k] !== undefined).map((k) => [k, plugin[k]])),
        source: archiveSource(plugin.version, sha256)
      }
    ]
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error("使い方: node scripts/write-marketplace.mjs dist-plugin/ksql-action-authoring-plugin-<版>.zip");
  const zip = readFileSync(file);
  const plugin = JSON.parse(readZip(zip).get(".claude-plugin/plugin.json").toString("utf8"));
  if (path.basename(file) !== zipName(plugin.version)) throw new Error(`zip の名前が版と合わない: ${path.basename(file)}（plugin.json は ${plugin.version}）`);
  const sha256 = createHash("sha256").update(zip).digest("hex");
  const out = path.join(root, ".claude-plugin", "marketplace.json");
  writeFileSync(out, `${JSON.stringify(marketplace(plugin, sha256), null, 2)}\n`);
  console.log(`[write-marketplace] ${out}（${plugin.name} ${plugin.version}、sha256 ${sha256}）`);
}
