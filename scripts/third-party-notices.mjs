// 束ねた依存の著作権表示（THIRD_PARTY_NOTICES.md。リリース手順 0-3）。scripts/build.mjs が呼ぶ。
// **formula MCP の scripts/third-party-notices.mjs からの写し**（あちらが正本。文だけ kact に合わせた）。
//   - esbuild の metafile から、出力に入った node_modules のパッケージを集める（出力のバイトが 0 のもの = 木揺すりで消えたものは除く）。
//     package.json の名前・版・ライセンスと、パッケージの LICENSE / NOTICE のファイルの全文を載せる。LICENSE のファイルが無いパッケージは止める
//   - vendor/ の moment は `npm run vendor`（scripts/vendor.mjs）が CDN から取るファイル。ライセンスの全文はここに持ち、版が変われば止める（全文を確かめて直す）
//   - 改行は \n にそろえる（Windows の checkout でも同じ中身。比べるときも \r\n を \n にする）
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const NOTICES_FILE = "THIRD_PARTY_NOTICES.md";

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

// moment 2.24.0 の LICENSE（中核の THIRD_PARTY_NOTICES.md と同じ）
const MOMENT_VERSION = "2.24.0";
const MOMENT_LICENSE = `Copyright (c) JS Foundation and other contributors

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.`;

export const eol = (s) => s.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** node_modules の中のファイルのパスから、パッケージのフォルダー（/ 区切り） */
export function packageDir(input) {
  const p = input.replace(/\\/g, "/");
  const i = p.lastIndexOf("node_modules/");
  if (i < 0) return undefined;
  const parts = p.slice(i + "node_modules/".length).split("/");
  return p.slice(0, i + "node_modules/".length) + (parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
}

/** package.json の repository（無ければ https の homepage）を https の URL に */
export function sourceUrl(pkg) {
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (typeof repo === "string") {
    const u = repo.trim().replace(/^git\+/, "").replace(/\.git$/, "");
    const short = u.match(/^(?:github:)?([\w.-]+\/[\w.-]+)$/);
    if (short) return `https://github.com/${short[1]}`;
    const https = u.replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://").replace(/^git@([^:/]+):/, "https://$1/");
    if (/^https:\/\/\S+$/.test(https)) return https;
  }
  return typeof pkg.homepage === "string" && /^https:\/\/\S+$/.test(pkg.homepage) ? pkg.homepage : undefined;
}

function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (typeof pkg.license?.type === "string") return pkg.license.type;
  const list = Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l?.type ?? l).filter((l) => typeof l === "string") : [];
  return list.length ? list.join(" OR ") : "（package.json に書かれていない）";
}

/**
 * 束ねた出力に入った node_modules のパッケージ
 * @param {string} root metafile のパスの基準（esbuild の absWorkingDir）
 * @param {{ label: string, metafile: { outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }> } }[]} builds
 */
export function bundledPackages(root, builds) {
  const found = new Map();
  for (const { label, metafile } of builds) {
    for (const out of Object.values(metafile.outputs)) {
      for (const [input, { bytesInOutput }] of Object.entries(out.inputs)) {
        const dir = bytesInOutput > 0 ? packageDir(input) : undefined;
        if (!dir) continue;
        if (!found.has(dir)) found.set(dir, []);
        if (!found.get(dir).includes(label)) found.get(dir).push(label);
      }
    }
  }
  const labels = builds.map((b) => b.label);
  return [...found]
    .map(([dir, where]) => {
      const abs = path.join(root, dir);
      const pkg = JSON.parse(readFileSync(path.join(abs, "package.json"), "utf8"));
      const files = readdirSync(abs).filter((f) => LICENSE_FILE.test(f)).sort(cmp);
      if (!files.length) throw new Error(`${pkg.name}@${pkg.version} に LICENSE のファイルが無い（ライセンスと著作権表示を手で確かめて、scripts/third-party-notices.mjs に足す）`);
      return {
        name: pkg.name,
        version: pkg.version,
        license: licenseOf(pkg),
        url: sourceUrl(pkg),
        where: where.sort((a, b) => labels.indexOf(a) - labels.indexOf(b)),
        texts: files.map((f) => eol(readFileSync(path.join(abs, f), "utf8")).trimEnd())
      };
    })
    .sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version));
}

/** vendor/ の moment（vendor/moment.json の版がライセンスの全文の版と同じか） */
export function vendorMoment(momentJson) {
  const m = JSON.parse(readFileSync(momentJson, "utf8"));
  if (m.version !== MOMENT_VERSION) throw new Error(`vendor/ の moment が ${m.version} になった（ライセンスの全文を確かめて、scripts/third-party-notices.mjs の MOMENT_VERSION と MOMENT_LICENSE を直す）`);
  return { version: m.version, license: m.license, url: m.url };
}

/** 文中のバッククォートより長い囲み */
function fenced(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}text`, text, fence];
}

/**
 * THIRD_PARTY_NOTICES.md の中身
 * @param {ReturnType<typeof bundledPackages>} packages
 * @param {ReturnType<typeof vendorMoment>} moment
 */
export function renderNotices(packages, moment) {
  const lines = [
    "# Third-party notices",
    "",
    "kact（kSQL アクションのオーサリング）の配布物（Claude Desktop の `.mcpb` と、Claude Code のプラグインの zip）に入れている第三者のソフトウェアと、そのライセンスです。",
    "",
    "このファイルは、ビルド（`scripts/build.mjs`）が束ねた依存から作ります。手で直さないでください（依存を変えたら `npm run notices` で作り直す。作り直していないとビルドが止まる）。",
    "",
    "## 一覧",
    "",
    "| パッケージ | 版 | ライセンス | 入る所 |",
    "| --- | --- | --- | --- |",
    ...packages.map((p) => `| ${p.name} | ${p.version} | ${p.license} | ${p.where.join("、")} |`),
    `| moment | ${moment.version} | ${moment.license} | vendor/ |`,
    "",
    "「ライセンス」の列は各パッケージの package.json の値です。条件は、各節の LICENSE の全文に従います（MCP の SDK のように、全文に MIT と Apache-2.0 の両方が書かれているものがあります）。",
    "",
    "- 本体: `dist/mcp.mjs`（MCP サーバー 1 ファイル。happy-dom も束ねてある）",
    "- vendor/: moment（kSQL アクションの manifest と同じ版）。計算式エンジンが読む",
    "",
    "利用者の kSQL アクションプラグインの zip から実行のときに読むもの（kSQL エンジン、計算式エンジン、設定画面のコードと plugin-config-kit、プラグインに同梱のライブラリ）は、配布物に入っていません。kSQL アクションプラグインの利用規約と、それぞれのライセンスに従います。"
  ];
  for (const p of packages) {
    lines.push("", `## ${p.name} ${p.version}`, "", `- ライセンス: ${p.license}`);
    if (p.url) lines.push(`- 入手先: ${p.url}`);
    lines.push(`- 入る所: ${p.where.join("、")}`);
    for (const t of p.texts) lines.push("", ...fenced(t));
  }
  lines.push(
    "",
    `## moment ${moment.version}`,
    "",
    `- ライセンス: ${moment.license}`,
    `- 入手先: ${moment.url}（kSQL アクションプラグインが読み込む CDN と同じファイル）`,
    "- 入る所: vendor/（`vendor/moment-with-locales.min.js`）",
    "",
    ...fenced(MOMENT_LICENSE)
  );
  return `${lines.join("\n")}\n`;
}
