/**
 * kact MCP サーバー（段階 3）。ツールの接頭辞は `kact_`。
 *
 * 起動の設定（AI の引数では変えない）:
 * - `--surface claude-code | desktop` … 出すツールの出し分け（印刷屋と同じ。今は同じだが口だけ先に用意する）
 * - 環境変数 `KACT_PLUGIN_ZIP` … kSQL アクションプラグインの zip（検査と計算式エンジンの元）
 * - 環境変数 `KACT_WORKSPACE` … 作業フォルダー（省略時は起動したフォルダー）
 * - 環境変数 `KACT_KINTONE_CONFIG` … kintone の接続のファイル（kSQL の ksql.config.json と同じ形。**作業フォルダーの外**）
 *
 * 守ること:
 * - **kintone へは GET だけ**（`kact_fields` / `kact_apps`。許す API は `kintone-rest.ts` に固定。レコードは読まない）
 * - ファイルは作業フォルダーからの**相対パス**だけ。`..`・絶対パス・symlink の外は拒否
 * - **SQL 本文・値・秘密の値は返さない**（一覧は要約だけ）。接続のファイルの場所と中身も返さない
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { checkConfig, listActions, statusOf } from "./core.ts";
import { resolveInWorkspace, workspaceStatus, WorkspaceError } from "./workspace.ts";
import { deleteAction, digestOf, filesOf, pullConfig, saveConfig, updateAction } from "./save.ts";
import { connectionReport, fetchFields, findFieldsFile, listApps, type KintoneOptions } from "./fields.ts";
import { diffConfigs } from "./diff.ts";
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

/** kintone の接続（起動の設定だけ。AI の引数では変えない。**場所も値も返さない**） */
function kintoneOptions(): KintoneOptions {
  const file = process.env.KACT_KINTONE_CONFIG?.trim();
  return { ...(file ? { configFile: file } : {}), env: process.env };
}

/**
 * 検査のときに使う項目定義（`kact_fields` が置いた控え）。封筒の appId で探す。
 * あれば計算式を**項目コードまで**検査し、無ければ構文だけ（返りの `summary.formulaCheck` に出る）
 */
function checkOptions(text: string): { pluginZip?: string; fields?: Record<string, unknown>; appId?: number; fieldsPath?: string } {
  const base = zipOptions();
  let appId = 0;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") appId = Number((parsed as { appId?: unknown }).appId ?? 0);
  } catch {
    return base;
  }
  if (!Number.isSafeInteger(appId) || appId <= 0) return base;
  const found = findFieldsFile(appId);
  return found ? { ...base, fields: found.file.properties, appId, fieldsPath: found.path } : base;
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
      description:
        "tools の版と、kSQL アクションプラグインの zip（版・オーサリング API の版・計算式エンジン）と、kintone の接続（接続のファイルが読めるか・profile・接続先のホスト・トークンを持つアプリ）の診断。" +
        "**秘密の値もファイルのパスも返さない**。kintone には通信しない。",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const conn = connectionReport(kintoneOptions());
      const r = await statusOf({ ...zipOptions(), connection: conn.report });
      return json({ surface, ...r, findings: [...r.findings, ...conn.findings] });
    },
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
      const opt = checkOptions(r.text);
      return json({ ...(await checkConfig(r.text, opt)), ...(opt.fieldsPath ? { fieldsFrom: opt.fieldsPath } : {}) });
    },
  );

  server.registerTool(
    "kact_actions",
    {
      title: "kact: アクションの一覧",
      description:
        "設定ファイルの中身を 1 アクション 1 行で返す（種類・起動・選択の渡し方・APPLY の有無・パラメーター名・SQL の行数）。SQL 本文と値は返さない。" +
        "返りの digest は kact_update_action の expectedDigest に渡す値。",
      inputSchema: { file: z.string().describe("作業フォルダーからの相対パス") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ file }) => {
      const r = readWorkspaceFile(file);
      if (!r.ok) return r.result;
      return json({ ...(await listActions(r.text, zipOptions())), digest: digestOf(r.text) });
    },
  );

  server.registerTool(
    "kact_files",
    {
      title: "kact: 作業フォルダーのファイル",
      description:
        "作業フォルダーの JSON の一覧。kSQL アクションの設定ファイルには digest（kact_update_action に渡す値）とアクションの数・アプリ ID も付く。中身は返さない。",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => json(await filesOf(zipOptions())),
  );

  server.registerTool(
    "kact_fields",
    {
      title: "kact: kintone の項目定義を取る",
      description:
        "アプリの項目定義（項目コード・型・ラベル・値の重複を禁止するか・テーブルの子）を kintone から**読み取り（GET）だけ**で取り、作業フォルダーの fields/<profile>/APP<番号>.json に控えて 1 項目 1 行の要約を返す。" +
        "**SQL と計算式には項目コードを書く**（表示名ではない）。取った後は kact_check と保存のツールが計算式を**項目コードまで検査**する（それまでは引用符・括弧の対応だけ）。" +
        "レコードの値は読まない。接続は利用者が設定した接続のファイルの profile だけで、ファイルの場所と秘密の値は返さない。結果を推し量らず、このツールで確かめる。",
      inputSchema: {
        app: z.number().int().positive().describe("アプリの番号（利用者に聞く。推測しない）"),
        profile: z.string().min(1).max(40).optional().describe("接続のファイルの profile（省略すると defaultProfile）"),
        preview: z.boolean().optional().describe("動作テスト環境（保存して未反映）の定義。設定画面が見るのはこちら。API トークンでは読めないことがある"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ app, profile, preview }) => json(await fetchFields({ app, ...(profile ? { profile } : {}), ...(preview ? { preview } : {}) }, kintoneOptions())),
  );

  server.registerTool(
    "kact_apps",
    {
      title: "kact: アプリの一覧",
      description:
        "接続のファイルの profile で見えるアプリの一覧（番号・名前・スペース）を**読み取り（GET）だけ**で返す。**ログイン名とパスワードの接続でだけ**使える（API トークンはアプリごとの鍵なので一覧は読めない）。" +
        "どのアプリを使うかは一覧から推測せず、**利用者に確かめる**。",
      inputSchema: {
        profile: z.string().min(1).max(40).optional().describe("接続のファイルの profile（省略すると defaultProfile）"),
        limit: z.number().int().min(1).max(100).optional().describe("返す件数（既定 100）"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ profile, limit }) => json(await listApps({ ...(profile ? { profile } : {}), ...(limit ? { limit } : {}) }, kintoneOptions())),
  );

  server.registerTool(
    "kact_save_config",
    {
      title: "kact: 新しい設定を保存",
      description:
        "新しい設定ファイル（設定画面にアップロードする封筒形式）を作業フォルダーに保存する。**保存の前にプラグイン本体と同じ検査を通し、エラーがあれば書かない**。" +
        "既にあるファイルは上書きしない（同じ名前なら conflict）。足りないキーは本体の既定値で埋まるので、変えるところだけ渡せばよい。",
      inputSchema: {
        file: z.string().min(1).max(200).describe("作業フォルダーからの相対パス（.json。例 settings/kact-1001.json）"),
        appId: z.number().int().positive().describe("取り込む先のアプリ ID（推測せず利用者に聞く）"),
        appName: z.string().max(200).optional().describe("アプリ名（封筒の表示だけに使う）"),
        config: z.record(z.unknown()).describe("設定の本体（configVersion / bindings / limits / timezone / actions）か封筒ごと。形は kact_docs の section config"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ file, appId, appName, config }) => json(await saveConfig({ file, appId, appName, config }, zipOptions())),
  );

  server.registerTool(
    "kact_update_action",
    {
      title: "kact: アクションを差し替える・足す",
      description:
        "既存の設定ファイルのアクションを 1 つ差し替える（同じコードが無ければ末尾に足す）。**kact_actions で読んだ digest を expectedDigest に渡す**（読んだ後に変わっていたら conflict）。" +
        "書く前に設定全体を本体と同じ規則で検査し、エラーがあれば書かない。" +
        "返りの changes に**直したところの差**（変わった行だけ）が入るので、利用者にはそれを見せる（同じファイルを書き替えるので kact_diff では見られない）。",
      inputSchema: {
        file: z.string().min(1).max(200).describe("作業フォルダーからの相対パス"),
        expectedDigest: z.string().min(16).max(128).describe("kact_actions か kact_files が返した digest"),
        action: z.record(z.unknown()).describe("アクション（code は必須。足りないキーは既定値で埋まる）"),
        replaceCode: z.string().min(1).max(64).optional().describe("差し替える相手のコード（コードを変えるときだけ。省略すると action.code と同じ行）"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ file, expectedDigest, action, replaceCode }) => json(await updateAction({ file, expectedDigest, action, replaceCode }, zipOptions())),
  );

  server.registerTool(
    "kact_delete_action",
    {
      title: "kact: アクションを消す",
      description:
        "既存の設定ファイルからアクションを 1 つ消す。**kact_actions で読んだ digest を expectedDigest に渡す**（読んだ後に変わっていたら conflict）。" +
        "取り込みは全置換なので、**残すつもりのないアクションは消す**（無効にして残すと、検査されない SQL がプラグイン設定に入ったまま運用に反映される）。" +
        "最後の 1 件は消せない（アクションが 0 件の設定は保存できない）。消す前に kact_actions で中身を見せ、**利用者に確かめてから呼ぶ**。",
      inputSchema: {
        file: z.string().min(1).max(200).describe("作業フォルダーからの相対パス"),
        expectedDigest: z.string().min(16).max(128).describe("kact_actions か kact_files が返した digest"),
        code: z.string().min(1).max(64).describe("消すアクションのコード"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ file, expectedDigest, code }) => json(await deleteAction({ file, expectedDigest, code }, zipOptions())),
  );

  server.registerTool(
    "kact_pull",
    {
      title: "kact: ダウンロードした設定を取り込む",
      description:
        "設定画面の［設定をダウンロード］で取った設定ファイルを、作業フォルダーに写す（直すときの元）。**元のファイルは残す**。" +
        "kSQL アクションの設定でなければ写さない。写す先に同じ名前があれば conflict。",
      inputSchema: {
        from: z.string().min(1).max(200).describe("ダウンロードしたファイル（作業フォルダーからの相対パス。例 inbox/kact-app1001.json）"),
        to: z.string().min(1).max(200).optional().describe("写す先（省略すると settings/APP<アプリ ID>.json）"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ from, to }) => json(await pullConfig({ from, to }, zipOptions())),
  );

  server.registerTool(
    "kact_diff",
    {
      title: "kact: 2 つの設定の差",
      description:
        "2 つの設定ファイルの差を、取り込む前に人が見る形で返す（アクションはコードで対応付け、SQL と計算式は変わった行だけ、そのほかは 古い → 新しい）。",
      inputSchema: {
        before: z.string().min(1).max(200).describe("前の設定（作業フォルダーからの相対パス）"),
        after: z.string().min(1).max(200).describe("後の設定（作業フォルダーからの相対パス）"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ before, after }) => {
      const a = readWorkspaceFile(before);
      if (!a.ok) return a.result;
      const b = readWorkspaceFile(after);
      if (!b.ok) return b.result;
      let diff: string;
      try {
        const x: unknown = JSON.parse(a.text);
        const y: unknown = JSON.parse(b.text);
        if (!x || typeof x !== "object" || !y || typeof y !== "object") throw new Error("設定ファイルがオブジェクトでない");
        diff = diffConfigs(x as Record<string, unknown>, y as Record<string, unknown>);
      } catch (e) {
        return json({ status: "invalid", findings: [{ level: "error", code: "parse-failed", message: e instanceof Error ? e.message : String(e) }] });
      }
      return text(diff ? `${before} → ${after}\n\n${diff}` : `${before} と ${after} に差は無い`);
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
