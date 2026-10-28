/**
 * kact MCP サーバー（段階 1）。ツールの接頭辞は `kact_`。
 *
 * 起動の設定（AI の引数では変えない）:
 * - `--surface claude-code | desktop` … 出すツールの出し分け（印刷屋と同じ。今は同じだが口だけ先に用意する）
 * - 環境変数 `KACT_PLUGIN_ZIP` … kSQL アクションプラグインの zip（検査と計算式エンジンの元）
 * - 環境変数 `KACT_WORKSPACE` … 作業フォルダー（省略時は起動したフォルダー）
 *
 * 守ること:
 * - **kintone には通信しない**（この段階）。zip と作業フォルダーのファイルだけ
 * - ファイルは作業フォルダーからの**相対パス**だけ。`..`・絶対パス・symlink の外は拒否
 * - **SQL 本文・値・秘密の値は返さない**（一覧は要約だけ）
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { checkConfig, listActions, statusOf } from "./core.ts";
import { resolveInWorkspace, workspaceStatus, WorkspaceError } from "./workspace.ts";
import { toolsMeta } from "./meta.ts";
import { DOCS, indexText, search, sectionKeys, sectionOf, sectionText } from "./docs.ts";

type Surface = "claude-code" | "desktop";

function surfaceOf(argv: string[]): Surface {
  const i = argv.indexOf("--surface");
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v === "desktop" ? "desktop" : "claude-code";
}

/** 返りは JSON 1 つ（全ツール共通の形。status と findings を含む） */
function json(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function text(t: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: t }] };
}

function zipOptions(): { pluginZip?: string } {
  const zip = process.env.KACT_PLUGIN_ZIP?.trim();
  return zip ? { pluginZip: zip } : {};
}

/** 作業フォルダーのファイルを読む（パスの検査つき）。失敗は findings の形で返す */
function readWorkspaceFile(file: string): { ok: true; text: string } | { ok: false; result: ReturnType<typeof json> } {
  try {
    return { ok: true, text: readFileSync(resolveInWorkspace(file), "utf8") };
  } catch (e) {
    const code = e instanceof WorkspaceError ? e.code : "read-failed";
    return {
      ok: false,
      result: json({ status: "invalid", findings: [{ level: "error", code, message: e instanceof Error ? e.message : String(e) }] }),
    };
  }
}

export function createServer(surface: Surface = "claude-code"): McpServer {
  const meta = toolsMeta();
  const server = new McpServer(
    { name: "ksql-action-authoring", version: meta.toolsVersion },
    {
      instructions:
        "kSQL アクションプラグインの設定を作る道具。設定を作る・直す前に kact_status で zip が読めるか確かめ、" +
        "作った設定は kact_check で検査してから利用者に渡す（取り込みと実行は利用者が設定画面で行う）。" +
        "kintone への書き込みは行わない。",
    },
  );

  server.registerTool(
    "kact_docs",
    {
      title: "kact: 手順と資料",
      description:
        "kintone の kSQL アクションプラグイン（rex0220 kSQL Action）で、ボタン・イベントから SQL を実行するアクションの設定を作る・直すとき、最初に呼ぶ。手順と資料（読み取りだけ）。" +
        "引数なしで目次（作業の順・決まり・章の一覧）、section でその章、query で資料から探す。" +
        "「kSQL アクションの設定」「ボタンで SQL を実行したい」と言われたらまずこれ。使い方・できること・頼み方を聞かれたら section navi",
      inputSchema: {
        section: z.string().min(1).max(60).optional().describe("章の名前（目次の section。例 howto-new、sql、patterns、apply、selection）"),
        query: z.string().min(1).max(100).optional().describe("探す言葉（空白で区切ると全部を含む節。例 APPLY 親）。section と一緒ならその章だけから"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ section, query }) => {
      if (DOCS.sections.length === 0) {
        return json({ status: "failed", findings: [{ level: "error", code: "docs-missing", message: "資料が埋め込まれていない（ビルドの誤り）" }] });
      }
      if (section !== undefined && !sectionOf(section)) {
        return json({ status: "invalid", findings: [{ level: "error", code: "unknown-section", message: `知らない section: ${section}。使える名前: ${sectionKeys().join("、")}` }] });
      }
      if (query !== undefined) {
        const r = search(query, section);
        if (r.count === 0) return text(`「${query}」に合う節は無い${section ? `（section: ${section}）` : ""}。目次は引数なしの kact_docs`);
        return text(`「${query}」に合う節 ${r.count} 件${r.truncated ? "（上限で打ち切った。言葉を絞る）" : ""}:\n\n${r.text}`);
      }
      if (section !== undefined) return text(sectionText(sectionOf(section)!));
      return text(indexText());
    },
  );

  server.registerTool(
    "kact_status",
    {
      title: "kact: 診断",
      description: "tools の版と、kSQL アクションプラグインの zip（版・オーサリング API の版・計算式エンジン）の診断。秘密の値は返さない。",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => json({ surface, ...(await statusOf(zipOptions())) }),
  );

  server.registerTool(
    "kact_workspace_status",
    {
      title: "kact: 作業フォルダーの診断",
      description: "作業フォルダーの場所と、その直下にある JSON ファイルの名前。中身は読まない。",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return json({ status: "ok", ...workspaceStatus(), findings: [] });
      } catch (e) {
        return json({ status: "failed", findings: [{ level: "error", code: "workspace", message: e instanceof Error ? e.message : String(e) }] });
      }
    },
  );

  server.registerTool(
    "kact_check",
    {
      title: "kact: 設定の検査",
      description:
        "設定ファイル（設定画面にアップロードする封筒形式の JSON）を、**プラグイン本体と同じ規則**で検査する。" +
        "エラー（保存できない）と注意（保存はできる）を findings で返す。",
      inputSchema: { file: z.string().describe("作業フォルダーからの相対パス（例: settings/kact-4377.json）") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ file }) => {
      const r = readWorkspaceFile(file);
      if (!r.ok) return r.result;
      return json(await checkConfig(r.text, zipOptions()));
    },
  );

  server.registerTool(
    "kact_actions",
    {
      title: "kact: アクションの一覧",
      description: "設定ファイルの中身を 1 アクション 1 行で返す（種類・起動・選択の渡し方・APPLY の有無・パラメーター名・SQL の行数）。SQL 本文と値は返さない。",
      inputSchema: { file: z.string().describe("作業フォルダーからの相対パス") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ file }) => {
      const r = readWorkspaceFile(file);
      if (!r.ok) return r.result;
      return json(await listActions(r.text, zipOptions()));
    },
  );

  return server;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const server = createServer(surfaceOf(argv));
  await server.connect(new StdioServerTransport());
}

// 直に起動されたときだけ動かす（試験は createServer を使う）
if (process.argv[1] && /mcp\.(ts|mjs|js)$/.test(process.argv[1])) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
