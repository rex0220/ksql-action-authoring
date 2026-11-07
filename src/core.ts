/**
 * tools の中核（段階 1）。zip のオーサリング API を使って、設定ファイルの診断・検査・一覧を行う。
 * MCP（`kact_status` / `kact_check` / `kact_actions`）と CLI の両方がここを呼ぶ。
 *
 * 約束:
 * - **kintone には通信しない**（この段階は作業フォルダーのファイルと zip だけ）
 * - **設定の中身（SQL 本文・値）はそのまま返さない**。行数・要点・項目コードだけを返す
 * - 返りは `{ status, findings, ... }` の形（status: ok / invalid / incompatible / failed）
 */
import { readFileSync } from "node:fs";
import { loadEngine, type Engine, type LoadEngineOptions } from "./engine.ts";
import { PluginZipError } from "./plugin-zip.ts";
import { toolsMeta } from "./meta.ts";

/** 返りの状態（印刷屋の MCP と同じ語。conflict と denied は段階 2 の保存で使う） */
export type ToolStatus = "ok" | "invalid" | "incompatible" | "conflict" | "denied" | "failed";

export interface Finding {
  /** error = 保存できない / warning = 保存はできる注意 / info = 参考 */
  level: "error" | "warning" | "info";
  /** 規則の名前（プラグインの検査のコード、または tools の判定） */
  code: string;
  message: string;
  /** 何番目のアクションか（1 始まり。設定全体のときは無し） */
  actionIndex?: number;
  actionCode?: string;
}

export interface StatusResult {
  status: ToolStatus;
  tools: ReturnType<typeof toolsMeta>;
  plugin?: {
    /** zip から読んだプラグインの版と API の版 */
    pluginVersion: string;
    apiVersion: number;
    pluginId?: string;
    /** 読み込んだファイルの sha256（zip が差し替わっていないかの照合に使う） */
    sha256: { engine: string; api?: string };
    /** 計算式エンジンが使えるか */
    formulaEngine: boolean;
  };
  /**
   * kintone の接続の診断（段階 3）。**秘密の値は出さない**: 出すのはファイルの名前（パスは出さない）、
   * profile の名前、接続先のホスト、認証の種類、トークンを持つアプリの番号と、それが使える状態か、まで
   */
  connection?: ConnectionReport;
  findings: Finding[];
}

export interface ConnectionReport {
  /** 接続のファイルが設定されているか（`KACT_KINTONE_CONFIG`） */
  configured: boolean;
  /** 読めたファイルの名前（パスは出さない） */
  fileName?: string;
  defaultProfile?: string;
  profiles?: Array<{
    profile: string;
    host: string;
    guestSpaceId: number | null;
    auth: "token" | "userpass";
    /** トークンを持つアプリの番号（値は持たない） */
    tokenApps: number[];
    /** アプリごとに、トークンが使える状態か（env: の変数があるか） */
    tokenReady: Record<number, boolean>;
    userpassReady: boolean;
  }>;
  /** 使えない profile と理由（値は含まない） */
  invalid?: Array<{ name: string; reason: string }>;
}

/** zip と tools の診断（kact_status）。zip の場所と接続のファイルの場所は呼び出し側が決めて渡す */
export async function statusOf(opt: LoadEngineOptions & { connection?: ConnectionReport } = {}): Promise<StatusResult> {
  const tools = toolsMeta();
  const connection = opt.connection ? { connection: opt.connection } : {};
  try {
    const engine = await loadEngine(opt);
    const findings: Finding[] = engine.warnings.map((w) => ({ level: "warning" as const, code: "zip-warning", message: w }));
    return {
      status: "ok",
      tools,
      plugin: {
        pluginVersion: String(engine.api.pluginVersion),
        apiVersion: Number(engine.api.apiVersion),
        ...(engine.source.pluginId ? { pluginId: engine.source.pluginId } : {}),
        sha256: { engine: engine.source.engineSha256, ...(engine.source.apiSha256 ? { api: engine.source.apiSha256 } : {}) },
        formulaEngine: engine.api.formulaEngineLoaded(),
      },
      ...connection,
      findings,
    };
  } catch (e) {
    const info = e instanceof PluginZipError ? e : undefined;
    return {
      status: info && (info.code === "unsupported-version" || info.code === "api-unsupported") ? "incompatible" : "failed",
      tools,
      ...connection,
      findings: [{ level: "error", code: info?.code ?? "engine-load-failed", message: e instanceof Error ? e.message : String(e) }],
    };
  }
}

/**
 * 封筒形式の設定ファイルを読む（pluginID と形を確かめる）。
 * **古い形は直してから検証する**（設定画面の取り込みと同じ順）。API の版 2 からは本体の `parseConfigFile` が
 * その順でやってくれる。版 1 の zip では `parseImport`（検証が先）なので、後から足した項目を持たない
 * 古いファイルは通らないことがある（その場合は新しい zip を使ってもらう）
 */
function parseConfigFile(engine: Engine, text: string): { config: Record<string, unknown>; envelope: Record<string, unknown> } {
  const api = engine.api as typeof engine.api & {
    parseConfigFile?: (text: string) => { data: Record<string, unknown>; envelope: Record<string, unknown> };
  };
  if (typeof api.parseConfigFile === "function") {
    const r = api.parseConfigFile(text);
    return { config: r.data, envelope: r.envelope };
  }
  const parsed = engine.api.parseImport(text, String(engine.api.pluginIdName), engine.api.CONFIG_SCHEMA) as {
    data: Record<string, unknown>;
    envelope: Record<string, unknown>;
  };
  const config = engine.api.migrateConfig(parsed.data) as Record<string, unknown>;
  return { config, envelope: parsed.envelope };
}

export interface CheckResult {
  status: ToolStatus;
  /** 設定の要約（値は含まない） */
  summary?: {
    actions: number;
    enabled: number;
    bindings: string[];
    logApp: boolean;
    /** アクションごとの SQL の行数 */
    sqlLines: number[];
    /** 計算式をどこまで見たか（`fields` = 項目コード・関数名まで、`syntax` = 引用符と括弧の対応だけ） */
    formulaCheck?: "fields" | "syntax";
  };
  findings: Finding[];
}

/** 計算式の口（設定画面の `collectFormulaProblems` と同じ。`where` は利用者に出す名前） */
/**
 * 計算式の 1 つの口。`checkFormulas` が**文脈を選ぶ**ために印を持つ。
 * - `param`: パラメーターの式（`source: "formula"` / `"keys"`）。**ここだけ `$val` / `$lno` が使える**
 *   （2026-11-06 の Codex レビュー MAJOR 1: 表示条件・実行条件まで許していた）
 * - `keys`: キーの配列（文脈は常にレコード）
 * - `input`: 入力の式（レコードが使えるのは詳細画面のボタンだけ）
 */
interface FormulaSlot {
  where: string;
  raw: string;
  param?: true;
  keys?: true;
  input?: true;
  /** 共通の文（`$m_…`）を書ける口（本体の `formulaContext.message(base)` を使う） */
  message?: true;
}

function formulaSlots(action: Record<string, unknown>): Array<FormulaSlot> {
  const slots: FormulaSlot[] = [
    { where: "showCond（表示条件）", raw: String(action.showCond ?? "") },
    { where: "execCond（実行条件）", raw: String(action.execCond ?? "") },
    // 共通の文を書ける口（本体は `formulaContext.message(base)` で検査する）
    { where: "execNgMessage（実行条件 NG のメッセージ）", raw: String(action.execNgMessage ?? ""), message: true },
    { where: "groupFormula（分ける式）", raw: String(action.groupFormula ?? "") },
    { where: "resultMessage（結果メッセージ）", raw: String(action.resultMessage ?? "") },
    /**
     * **ループの式**（本体の `dialogs.ts` も検査している。2026-11-06 の Codex レビュー MAJOR 2）。
     * 文脈は起動の形で決まる `base` のままで、**`$val` / `$lno` は足さない**
     * （回数を決める式そのものなので、回の値は使えない。`loop` の章）
     */
    { where: "loop（ループの式）", raw: String(action.loop ?? "") },
  ];
  /**
   * **無効の行（`enabled: false`）は検査しない**（本体の `dialogs.ts` の `structuralProblems` と `paramRule` と同じ）。
   * 無効は「注入しない / 聞かない」だけで行は残る作りで、**作りかけの式を置いたままにできる**のが狙い
   * （2026-11-05 Takashi「一時的に無効にできるようにして」）。ここで検査すると、設定画面では保存できる設定を
   * tools だけが拒むことになる（`checkOrFail` がエラーで書き込みを止めるため）
   */
  for (const p of (Array.isArray(action.params) ? action.params : []) as Array<Record<string, unknown>>) {
    if (p.enabled === false) continue;
    if (p.source === "formula") slots.push({ where: `params ${String(p.name ?? "")} の式`, raw: String(p.formula ?? ""), param: true });
    /**
     * **`source: "keys"` の式も検査する**（本体の `paramRule` は `formula` と `keys` の両方を見る）。
     * 文脈は**常にレコード**（本体の `keysContext`）。キーの配列は「その起動で関係するレコードすべて」に
     * 式を当てて作るので、アプリ種別や「まとめて 1 回」でもレコードの項目が書ける
     */
    if (p.source === "keys") slots.push({ where: `params ${String(p.name ?? "")} の式（キーの配列）`, raw: String(p.formula ?? ""), param: true, keys: true });
  }
  /**
   * 入力の式には `input: true` を付ける。**レコード文脈の規則がほかと違う**ので、
   * `checkFormulas` が文脈を選ぶときに要る（本体の `inputUsesRecord`。2026-11-05 の Codex レビュー MAJOR 5）
   */
  for (const i of (Array.isArray(action.inputs) ? action.inputs : []) as Array<Record<string, unknown>>) {
    if (i.enabled === false) continue; // 無効の行は検査しない（上の params と同じ）
    const at = `inputs ${String(i.name ?? "")}`;
    slots.push({ where: `${at} の既定値`, raw: String(i.defaultFormula ?? ""), input: true });
    // 選択肢の値とラベルの式（2026-11-05 に本体へ足した。型が選択肢のときだけ効く）
    if (i.type === "select") {
      slots.push({ where: `${at} の選択肢の値`, raw: String(i.optionsFormula ?? ""), input: true });
      // 選択肢のラベルも共通の文を書ける口（本体の dialogs.ts と同じ）
      slots.push({ where: `${at} の選択肢のラベル`, raw: String(i.optionLabelsFormula ?? ""), input: true, message: true });
    }
  }
  return slots.filter((s) => s.raw.trim() !== "");
}

/** 項目定義が無い文脈でも分かる誤り（= 構文）だけを拾う。項目名・関数名の誤りは「項目が無い」と同じ形で出るので除く */
const UNKNOWN_NAME = /FIELD CODE NOT FOUND:\s*([\s\S]*)$/;

/**
 * 「項目が無い」と言われた名前に、**項目コードには入らない文字**（空白・引用符・句読点）が混じっていたら、
 * それは項目参照ではなく**引用符を忘れた素の文**。2026-10-28 の試用（S4）で、`execNgMessage` に
 * 引用符の無い文（`顧客コードが空のため…ください。`）が入ったまま検査を通っていた。
 * 括弧・引用符の**対応は取れている**ので構文としては正しく、項目定義が入る段階 3 までは区別できない。
 * **error にはしない**（本物の項目名を弾かないため。保存は止めずに警告で伝える）。
 */
const NOT_A_FIELD_CODE = /[\s"'。、，．！？!?]/;

/** 計算式の文脈（`loadFormulaContext` が作る形。アクションの種類で使い分ける） */
export interface FormulaContexts {
  record: { pp: unknown; crec: unknown };
  none: { pp: unknown; crec: unknown };
  result: (base: "record" | "none") => { pp: unknown; crec: unknown };
  /**
   * **ループのあるアクションのパラメーターの文脈**（`$val` / `$lno` が使える。本体の `formula-check.ts`）。
   * 2026-11-06 の Codex レビュー MAJOR 3: ここを使っていなかったので、
   * **ループのアクションで `$val` を使ったパラメーターを tools だけが「無い項目」と拒んでいた**
   * （`loop` の章が勧める `"formula": "2017 + $val"` がそのまま弾かれる）
   */
  loopParam?: (base: "record" | "none") => { pp: unknown; crec: unknown };
  /**
   * **共通の文を書ける口の文脈**（`$m_…` が使える。本体の `formula-check.ts` の `message`）。
   * 本体の設定画面は `execNgMessage` と `inputs[].optionLabelsFormula` にこれを使う
   * （`ksql-action/src/config/dialogs.ts`）。**ここを使っていなかったので、
   * `messages` に正しく定義した `$m_…` を NG の文に書くと tools だけが拒んでいた**
   * （2026-11-07 の試用 S10）。`resultMessage` は `result` 側が `$m_…` も足すので別口。
   */
  message?: (base: "record" | "none") => { pp: unknown; crec: unknown };
}

/**
 * 項目定義から計算式の文脈を作る（**本体の `loadFormulaContext` をそのまま使う**。項目の型から検査用のレコードを組む
 * ところを写さないため）。`loadFormulaContext` は `/k/v1/preview/app/form/fields` を 1 回だけ読むので、
 * kintone に行かず控え（`kact_fields` が置いた properties）を返す偽の client を渡す。
 */
export async function contextsFrom(
  engine: Engine,
  properties: Record<string, unknown>,
  appId: number,
  /**
   * **共通の文（`messages`）を必ず渡す**（§8.4。API 版 7）。
   *
   * 渡さないと `$m_…` の擬似項目が 1 つも無い状態で式を検査することになり、
   * **`messages` に正しく定義してある `$m_…` まで「無い項目」で止まる**
   * （＝ 共通の文を使う設定は、ツールからは 1 つも保存できない）。
   * 本体の設定画面は 2026-11-06 に同じ穴を踏んで `setMessages` で直したが
   * （`ksql-action/src/config/screen.ts` の注記）、**こちらには入っていなかった**
   * （2026-11-07 の試用 S10 で発覚）。
   */
  messages?: unknown,
): Promise<FormulaContexts> {
  const client = { api: async () => ({ properties }) };
  return (await engine.api.loadFormulaContext(client as never, appId, messages)) as unknown as FormulaContexts;
}

/** 項目定義が無い文脈でも分かる誤り（= 構文）だけを拾う。項目名・関数名の誤りは「項目が無い」と同じ形で出るので除く */
const UNKNOWN_NAME_RE = UNKNOWN_NAME;

/**
 * 計算式を見る。
 * - **項目定義が無いとき（`contexts` なし）は構文だけ**（引用符・括弧の対応）。項目名・関数名は「項目が無い」と
 *   同じ形で返るので区別できない（2026-10-28 の試用 S3 で、引用符が落ちた `resultMessage` が通っていたため足した）
 * - **項目定義があるとき（`kact_fields` の控え）は設定画面の保存と同じ検査**（`collectFormulaProblems` と同じ口・
 *   同じ文脈の使い分け）。項目コードと関数名の誤りもここで止まる
 * **findings に式そのものは入れない**（口の名前だけ出す。設定の中身は返さない約束）。
 */
function checkFormulas(engine: Engine, actions: Array<Record<string, unknown>>, contexts?: FormulaContexts): Finding[] {
  if (!engine.api.formulaEngineLoaded()) {
    return [{ level: "warning", code: "formula-engine-missing", message: "計算式エンジンが読めないので、式は見ていない" }];
  }
  const findings: Finding[] = [];
  const emptyContext = { pp: {}, crec: {} };
  for (const [i, action] of actions.entries()) {
    if (action.enabled === false) continue;
    const at = { actionIndex: i + 1, actionCode: String(action.code ?? "") };
    // 設定画面の baseKey と同じ: アプリ種別と「まとめて 1 回 / グループごと」はレコード文脈が無い
    const noRecord = action.type === "app" || engine.api.isSelectionNoRecord(action as never);
    const base: "record" | "none" = noRecord ? "none" : "record";
    /**
     * **入力の式（既定値・選択肢）だけは規則が違う**（本体の `inputUsesRecord`。2026-11-05）。
     * 入力は起動 1 回につき 1 回しか聞かないので、一覧からの起動は「1 件ずつ」でもレコードが無い。
     * ここを `base` のままにすると、一覧の「1 件ずつ」でレコードの項目を使った式を
     * tools が通してしまい、**設定画面の保存で初めて止まる**（利用者には理由が分からない）
     */
    const inputBase: "record" | "none" = action.type === "record" && action.onList !== true ? "record" : "none";
    /**
     * **ループのあるアクションは、パラメーターの式で `$val` / `$lno` が使える**（本体の `paramContext` /
     * `keysContext`。2026-11-06 の Codex レビュー MAJOR 3）。判定は**本体の `hasLoop`**に任せる
     * （「`loop` がコメントを除いて空でないか」を写すと本物とずれる。API の版 5 で公開した）。
     * 版 4 までの zip には口が無いので、そのときはこれまでどおりの文脈で見る
     */
    const loopApi = (engine.api as { hasLoop?: (a: unknown) => boolean }).hasLoop;
    const looped = typeof loopApi === "function" && loopApi(action) && typeof contexts?.loopParam === "function";
    /** パラメーターの文脈（`keys` は常にレコード、ほかは起動の形で決まる `base`） */
    const paramContext = (keys: boolean): { pp: unknown; crec: unknown } => {
      const kind: "record" | "none" = keys ? "record" : base;
      return looped ? contexts!.loopParam!(kind) : contexts![kind];
    };
    for (const slot of formulaSlots(action)) {
      const context = !contexts
        ? emptyContext
        : slot.where.startsWith("resultMessage")
          ? contexts.result(base)
          : slot.where.startsWith("groupFormula")
            ? contexts.record // 分ける式はレコードごとに評価する（本体の groupContext）
            : slot.message && contexts.message
              // 共通の文を書ける口（NG の文・選択肢のラベル）。本体の dialogs.ts と同じ文脈
              ? contexts.message(slot.input ? inputBase : base)
              : slot.input
              ? contexts[inputBase] // 入力の式はループ値を使えない（聞くのはループの前に 1 回）
              : slot.param
                ? paramContext(slot.keys === true) // パラメーターの式だけ $val / $lno が使える
                : contexts[base]; // 表示条件・実行条件・NG の文・ループの式はふつうの文脈
      const r = engine.api.checkFormula(context, slot.raw) as { ok: boolean; msg?: string };
      if (r.ok) continue;
      const unknown = UNKNOWN_NAME_RE.exec(r.msg ?? "");
      if (unknown && !contexts) {
        // 項目名・関数名の誤りは項目定義が無いと区別できない。ただし項目コードに入らない文字が混じっていれば引用符の抜け
        if (NOT_A_FIELD_CODE.test(unknown[1] ?? "")) {
          findings.push({
            level: "warning",
            code: "pFormulaQuote",
            message: `${slot.where}: 引用符 " の抜けかもしれない（固定の文も "…" で囲む。囲まないと項目コードとして読まれる）`,
            ...at,
          });
        }
        continue;
      }
      if (unknown) {
        // 項目定義があるので「項目が無い」は本当の誤り（名前だけ出す。式は出さない）
        const name = (unknown[1] ?? "").slice(0, 64);
        findings.push({
          level: "error",
          code: "pFormulaField",
          message: `${slot.where}: 「${name}」という項目も関数も無い（項目コードで書く。表示名ではない。使えない文脈のことも）`
            + renameHint(name),
          ...at,
        });
        continue;
      }
      findings.push({
        level: "error",
        code: "pFormulaSyntax",
        message: `${slot.where}: 式の構文が通らない（引用符 " と括弧の対応を確かめる）`,
        ...at,
      });
    }
  }
  return findings;
}

export interface CheckOptions extends LoadEngineOptions {
  /**
   * 自アプリの項目定義（`kact_fields` が置いた控えの `properties`）。渡すと計算式を
   * **設定画面の保存と同じ検査**（項目コード・関数名まで）に上げる。無ければ構文だけ見る
   */
  fields?: Record<string, unknown>;
  /** 項目定義を渡すときの自アプリの番号（`loadFormulaContext` に渡す。省略時は封筒の appId） */
  appId?: number;
  /**
   * **SQL が触るアプリの項目定義**（`アプリ番号 → properties`。`kact_explain` に渡すのと同じ形）。
   * 選択肢の定義に無い値（`choice-unknown`。API 版 8）を見るための `createFieldsClient` に渡す。
   *
   * **`fields` とは形が違う**（あちらは自アプリの `properties` で、キーは項目コード）。
   * 1 つの口で兼ねると、`createFieldsClient` に項目コードをアプリ番号として渡すことになり
   * （`getFields` が throw して `catch` に落ちるので）**検査が黙って何もしない**
   * （2026-11-07 の試用 S4 の再実施で見つけた。API 版 8 の検査が一度も鳴っていなかった）。
   */
  appsFields?: Record<string, Record<string, unknown>>;
}

/**
 * 設定ファイルの検査（kact_check）。**設定画面の保存と同じ規則**を zip の API で通す。
 * - 形（CONFIG_SCHEMA）と横断の検査（validateConfig）
 * - アクションごとに SQL の検査（checkActionSql。注意も返す）
 * - 計算式は、項目定義（`fields`）を渡せば**設定画面の保存と同じ検査**、無ければ**構文だけ**（`checkFormulas`）
 */
export async function checkConfig(text: string, opt: CheckOptions = {}): Promise<CheckResult> {
  let engine: Engine;
  try {
    engine = await loadEngine(opt);
  } catch (e) {
    const info = e instanceof PluginZipError ? e : undefined;
    return { status: "failed", findings: [{ level: "error", code: info?.code ?? "engine-load-failed", message: e instanceof Error ? e.message : String(e) }] };
  }

  const findings: Finding[] = [];
  let config: Record<string, unknown>;
  let envelope: Record<string, unknown>;
  try {
    ({ config, envelope } = parseConfigFile(engine, text));
  } catch (e) {
    return { status: "invalid", findings: [{ level: "error", code: "parse-failed", message: e instanceof Error ? e.message : String(e) }] };
  }

  // 1 形（スキーマ）
  try {
    engine.api.validateSchema(config);
  } catch (e) {
    findings.push({ level: "error", code: "schema", message: e instanceof Error ? e.message : String(e) });
  }

  // 2 横断の検査（コードの重複・イベントの整合など）。
  // 本体が返すのは `action[0]:app:placement` のような**規則のコードだけ**で、
  // 何を直せばよいかが読めない（2026-11-06 の試用 S2）。読み方を添える
  for (const issue of engine.api.validateConfig(config as never) as string[]) {
    findings.push({
      level: "error",
      code: "config",
      message: `${issue}（設定の規則に反している。形は「どこ:規則」で、action[n] は n 番目のアクション（0 から）。意味は kact_docs の section config）`,
    });
  }

  // 3 アクションごとの SQL
  const actions = Array.isArray(config.actions) ? (config.actions as Array<Record<string, unknown>>) : [];
  const bindings = (Array.isArray(config.bindings) ? config.bindings : []) as Array<{ name: string; appId: number }>;

  // 2b 区分の名前が定義にあるか（2026-11-06 の試用 S3）。
  // 一覧は `viewRow.sections.includes(a.panelSection)` で選ぶので、定義に無い区分の
  // アクションは**どの一覧にも出ない**（詳細画面はボタンとして出る）。設定画面の区分欄は
  // 選択式なので起きないが、**ファイルから作るときは素通り**して、静かに消える
  for (const f of unknownSectionFindings(config, actions)) findings.push(f);
  // 2c 一覧に出るのに `panel.views` のどの行にも載っていない（2026-11-06 の試用 S4）。
  // `wUnknownSection` は「定義に無い区分」だけを見るので、区分なしと
  // 「定義済みだが どの一覧にも載せていない」は素通りしていた
  for (const f of nowhereShownFindings(config, actions)) findings.push(f);
  // 2d 一覧の「1 件ずつ」のままテーブルを全置換している（2026-11-07 の試用 S5）。
  // 既定が "loop" なので、渡し方を書き忘れただけでこの形になる
  for (const f of listApplyLoopFindings(actions)) findings.push(f);
  /**
   * 控えの項目定義から作る client（API 版 3 の `createFieldsClient`）。**通信しない**（手元の
   * `properties` を返すだけ）。これを `checkActionSql` に渡すと、選択肢の定義に無い値
   * （`choiceUnknown`。API 版 8。§8.6）まで見てくれる。
   * 控えが無いアプリがあると本体側が黙って飛ばすので、渡せるときだけ渡す
   */
  const fieldsClient = (() => {
    // **`appsFields`（アプリ番号 → properties）だけを使う。** `fields`（自アプリの properties）を
    // 渡すと項目コードをアプリ番号として扱うことになり、検査が黙って何もしない
    const cache = opt.appsFields;
    if (!cache || Object.keys(cache).length === 0) return undefined;
    const make = (engine.api as { createFieldsClient?: (f: Record<string, Record<string, unknown>>) => unknown })
      .createFieldsClient;
    if (typeof make !== "function") return undefined;
    try {
      return make(cache as Record<string, Record<string, unknown>>);
    } catch {
      return undefined;
    }
  })();
  for (const [i, action] of actions.entries()) {
    if (action.enabled === false) continue;
    /**
     * 共通の文の表を**必ず渡す**（API 版 7。§8.4）。渡さないと `DECLARE @m_…` と
     * `ASSERT …, @m_…` が「表に無い」で error になる（本体が黙って通さない向きに倒してある）
     */
    const r = (await engine.api.checkActionSql(action as never, bindings, {
      messages: config.messages,
      ...(fieldsClient ? { client: fieldsClient } : {}),
    })) as {
      problems: Array<{ code: string; detail?: string; index?: number; kind?: string }>;
      warnings: Array<{ code: string; message: string }>;
      /** API 版 8 から。古い zip では undefined */
      choiceUnknown?: Array<{ field: string; value: string; kind: string; options: string[] }>;
    };
    const at = { actionIndex: i + 1, actionCode: String(action.code ?? "") };
    for (const p of r.problems) {
      findings.push({ level: "error", code: p.code, message: problemMessage(engine, p), ...at });
    }
    for (const w of r.warnings) findings.push({ level: "warning", code: w.code, message: w.message, ...at });
    /**
     * 選択肢の定義に無い値（§8.6。API 版 8）。kintone の「言語ごとの名称」で選択肢に
     * 表示名を付けている項目に**表示名**を書くと、エラーにならず **0 件**になる。
     * SQL には `kact_fields` が見せている**既定の名称**を書く
     */
    for (const c of r.choiceUnknown ?? []) {
      findings.push({
        level: "warning",
        code: "choice-unknown",
        message: `${c.field} の選択肢に "${c.value}" はありません（選択肢: ${c.options.join(" / ")}）。項目に「言語ごとの名称」を設定していても、SQL には kact_fields が返す既定の名称を書きます`,
        ...at,
      });
    }
  }

  // 4 計算式（項目定義があれば設定画面と同じ検査、無ければ構文だけ）
  let contexts: FormulaContexts | undefined;
  if (opt.fields) {
    const appId = opt.appId ?? Number(envelope.appId ?? 0);
    if (!Number.isSafeInteger(appId) || appId <= 0) {
      findings.push({ level: "warning", code: "fields-no-app", message: "項目定義を渡されたが自アプリの番号が分からないので、計算式は構文だけ見た" });
    } else {
      try {
        // 共通の文を渡す（渡さないと `$m_…` が「無い項目」になる。`contextsFrom` の注記）
        contexts = await contextsFrom(engine, opt.fields, appId, config.messages);
      } catch (e) {
        findings.push({ level: "warning", code: "fields-context-failed", message: `項目定義から計算式の文脈を作れなかったので構文だけ見た: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }
  findings.push(...checkFormulas(engine, actions, contexts));

  const enabled = actions.filter((a) => a.enabled !== false).length;
  return {
    status: findings.some((f) => f.level === "error") ? "invalid" : "ok",
    summary: {
      actions: actions.length,
      enabled,
      bindings: bindings.map((b) => `${b.name}=${b.appId}`),
      logApp: !!config.logApp,
      sqlLines: actions.map((a) => String(a.sql ?? "").split("\n").length),
      /** 計算式をどこまで見たか（項目コードまで見たか、構文だけか） */
      formulaCheck: contexts ? "fields" : "syntax",
    },
    findings,
  };
}

export interface ActionSummary {
  index: number;
  code: string;
  name: string;
  enabled: boolean;
  /** 種類（`record` / `app`。2026-10-31 に 3 つから 2 つになった） */
  type: string;
  /** 一覧画面でも使う（種類 record だけ。選んだレコードに実行） */
  onList: boolean;
  placements: string[];
  /** 一覧パネルの区分（空 = 区分なし） */
  panelSection: string;
  /** 一覧の選択の渡し方（「一覧でも使う」のときだけ意味がある） */
  selectionMode?: string;
  /** ループの式（空 = ループなし。§5.7。本文は短いのでそのまま返す） */
  loop?: string;
  /** ループの回が失敗したとき（`stop` / `continue`。ループありのときだけ） */
  loopOnError?: string;
  confirm: boolean;
  writeLimit: number;
  /** SQL の行数と、使っている文の種類（本文は返さない） */
  sqlLines: number;
  /** テーブルへの書き戻し（APPLY）を含むか */
  apply: boolean;
  params: string[];
  inputs: string[];
}

export interface ExplainOptions extends LoadEngineOptions {
  /** 控えの項目定義（アプリ番号 → `kact_fields` が置いた `properties`）。mcp 側が集めて渡す */
  fields?: Record<string, Record<string, unknown>>;
}

export interface ExplainResult {
  status: ToolStatus;
  action?: { index: number; code: string; name: string };
  /** 文ごとの種類と計画（エンジンの EXPLAIN） */
  statements?: Array<{ index: number; type: string; plan: string[] }>;
  /** 控えを使ったアプリの番号（通信はしていない） */
  usedApps?: number[];
  findings: Finding[];
}

/**
 * 実行計画（kact_explain）。エンジンの EXPLAIN を**控えの項目定義だけ**で回す。
 * **kintone には行かない**（`explainScript` が client に聞くのは `getFields(アプリ番号)` だけで、レコードは読まない）。
 * 控えの無いアプリがあれば、その番号を findings で知らせる（`kact_fields` で取ってから、と言う）
 */
export async function explainAction(text: string, input: { action: string | number }, opt: ExplainOptions = {}): Promise<ExplainResult> {
  let engine: Engine;
  try {
    engine = await loadEngine(opt);
  } catch (e) {
    const info = e instanceof PluginZipError ? e : undefined;
    return { status: "failed", findings: [{ level: "error", code: info?.code ?? "engine-load-failed", message: e instanceof Error ? e.message : String(e) }] };
  }
  const api = engine.api as typeof engine.api & {
    explainActionSql?: (action: unknown, bindings: unknown, client: unknown) => Promise<{ statements: Array<{ index: number; type: string; plan: string[] }> }>;
    createFieldsClient?: (fields: Record<string, Record<string, unknown>>) => unknown;
  };
  if (typeof api.explainActionSql !== "function" || typeof api.createFieldsClient !== "function") {
    return {
      status: "incompatible",
      findings: [{ level: "error", code: "api-too-old", message: "この zip のオーサリング API には実行計画が無い（Ver. を上げたプラグインの zip が要る）" }],
    };
  }
  let config: Record<string, unknown>;
  try {
    ({ config } = parseConfigFile(engine, text));
  } catch (e) {
    return { status: "invalid", findings: [{ level: "error", code: "parse-failed", message: e instanceof Error ? e.message : String(e) }] };
  }
  const actions = (Array.isArray(config.actions) ? config.actions : []) as Array<Record<string, unknown>>;
  const at =
    typeof input.action === "number"
      ? actions.findIndex((_a, i) => i + 1 === input.action)
      : actions.findIndex((a) => String(a.code ?? "") === String(input.action));
  const action = at >= 0 ? actions[at] : undefined;
  if (!action) {
    return {
      status: "invalid",
      findings: [{ level: "error", code: "action-not-found", message: `アクションが見つからない: ${String(input.action)}（コードか 1 からの番号で渡す。一覧は kact_actions）` }],
    };
  }
  const bindings = (Array.isArray(config.bindings) ? config.bindings : []) as Array<{ name: string; appId: number }>;
  const cache = opt.fields ?? {};
  const usedApps: number[] = [];
  const missing: number[] = [];
  /**
   * エンジンの client は**本体に作らせる**（`createFieldsClient`）。手元の fetch で項目定義だけを返すので、
   * 通信しない・レコードは読まない。控えの無いアプリはエラーになるので、番号を控えて findings にする
   */
  const served: Record<string, Record<string, unknown>> = {};
  for (const [id, properties] of Object.entries(cache)) {
    served[id] = properties;
    usedApps.push(Number(id));
  }
  for (const b of (Array.isArray(config.bindings) ? config.bindings : []) as Array<{ appId?: unknown }>) {
    const id = Number(b?.appId ?? 0);
    if (Number.isSafeInteger(id) && id > 0 && !served[String(id)] && !missing.includes(id)) missing.push(id);
  }
  const client = api.createFieldsClient(served);
  const findings: Finding[] = [];
  let statements: Array<{ index: number; type: string; plan: string[] }>;
  try {
    const r = await api.explainActionSql(action, bindings, client);
    statements = r.statements;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    for (const id of missing) {
      findings.push({ level: "error", code: "fields-missing", message: `アプリ ${id} の項目定義の控えが無い（kact_fields で取る）` });
    }
    findings.push({ level: "error", code: "explain-failed", message });
    return { status: "invalid", action: { index: at + 1, code: String(action.code ?? ""), name: String(action.name ?? "") }, findings };
  }
  for (const id of missing) {
    findings.push({ level: "warning", code: "fields-missing", message: `アプリ ${id} の項目定義の控えが無いまま計画を出した（kact_fields で取ると正しくなる）` });
  }
  const arrayVars = arrayDeclareNames(String(action.sql ?? ""));
  if (arrayVars.length > 0) {
    findings.push({
      level: "info",
      code: "explain-array-empty",
      message:
        `配列の変数（${arrayVars.map((n) => `@${n}`).join(" / ")}）は、計画では**空の配列**として扱われる`
        + "（実行計画は値を注入しない）。そのため `IN @…` の文は `predicate: constant false`・`mode: FULL_SCAN` と出て、"
        + "読み取りの見積もりも上限（`readMax`）での最大になる。**条件が効いていないという意味ではない**"
        + "（実行時は `IN (…)` で絞られ、kintone の条件として送られる）。"
        + "計画で全件取得を見つけたいときは、`WHERE` を書き忘れた文に `predicate` の行が無いことを見る",
    });
  }
  return { status: "ok", action: { index: at + 1, code: String(action.code ?? ""), name: String(action.name ?? "") }, statements, usedApps, findings };
}

/**
 * アクションの区分（`panelSection`）が `panel.sections` に**有効な区分として定義されているか**。
 *
 * 一覧の起動口は `viewRow.sections` / `viewRow.menus`（どちらも定義済みの区分の名前）との
 * 突き合わせで選ぶので、**定義に無い名前のアクションはどの一覧にも出ない**。
 * 詳細画面には（`placements` に `detail_menu` があれば）ボタンとして出るので、
 * `placements` も空なら**どこにも出ない設定**になる。
 * 設定画面の区分の欄は選択式なので手では起きないが、**ファイルから作るときは素通りする**
 * （2026-11-06 の試用 S3 で、存在しない区分「保守」が警告なしで保存できた）。
 *
 * 無効（`enabled: false`）の区分は「定義していないのと同じ」（`config` の章）なので同じ扱いにする。
 */
export function unknownSectionFindings(
  config: Record<string, unknown>,
  actions: Array<Record<string, unknown>>,
): Finding[] {
  const panel = config.panel;
  const defs = panel && typeof panel === "object" && Array.isArray((panel as { sections?: unknown }).sections)
    ? ((panel as { sections: unknown[] }).sections)
    : [];
  const known = new Set(
    defs
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .filter((s) => s.enabled !== false)
      .map((s) => String(s.name ?? "").trim())
      .filter(Boolean),
  );
  const out: Finding[] = [];
  for (const [i, action] of actions.entries()) {
    if (action.enabled === false) continue;
    const name = String(action.panelSection ?? "").trim();
    if (!name || known.has(name)) continue;
    const onList = action.type === "app" || action.onList === true;
    const onDetail = Array.isArray(action.placements) && action.placements.includes("detail_menu");
    out.push({
      level: "warning",
      code: "wUnknownSection",
      message:
        `区分「${name}」が共通設定の区分（panel.sections）に有効なものとして定義されていません。`
        + "一覧の起動口は定義済みの区分としか突き合わせないので、**このアクションはどの一覧にも出ません**"
        + (onDetail
          ? "（詳細画面にはボタンとして出ます）。"
          : onList
            ? "。`placements` に `detail_menu` も無いので、**どこにも出ません**。"
            : "。")
        + " 区分を `panel.sections` に足すか、既にある区分の名前に直してください"
        + "（区分の追加・名前の確認は設定画面の［パネル・区分］で行います。ツールからは `panel` を読めません）",
      actionIndex: i + 1,
      actionCode: String(action.code ?? ""),
    });
  }
  return out;
}

/**
 * 一覧に出るアクションが、**`panel.views` のどの行にも載っていない**か
 * （2026-11-06 の試用 S4）。
 *
 * 一覧の起動口は `viewRow.sections.includes(a.panelSection.trim())`（パネル）と
 * `viewRow.menus`（メニュー）で選ぶ（本体の `src/desktop/index-screen.ts`）。
 * **並べるのは「区分の名前」で、区分を付けていないアクションの名前は `""`**。
 * だから `"sections": [""]` が「区分なしのボタンをパネルに出す」指定で、
 * **`"sections": []` は「この一覧には何も出さない」**（空は「ぜんぶ」ではない）。
 *
 * `wUnknownSection` が見るのは「定義に無い区分」だけなので、
 * - 区分なし（`""`）で、どの行にも `""` を載せていない
 * - 定義済みの区分だが、どの行の `sections` / `menus` にも載せていない
 * の 2 つは素通りして、**警告なしでどこにも出ない設定**になっていた。
 * 本体の設定画面は後者に「nowhere」の印を出すが（`src/config/screen.ts`）、
 * 前者は `if (name === "") return "";` で早期に抜けるので印も出ない。
 * どちらも**ファイルから作るときだけの穴**で、`wUnknownSection` と同じ理由で拾う。
 *
 * `panel` を省いた設定は既定（`sections: [""]`）なので**出る**。省略を既定として扱う。
 * イベント起動だけのアクションと、詳細画面のボタンがあるものには出さない（出る口がある）。
 */
export function nowhereShownFindings(
  config: Record<string, unknown>,
  actions: Array<Record<string, unknown>>,
): Finding[] {
  const panel = (config.panel && typeof config.panel === "object" ? config.panel : {}) as Record<string, unknown>;
  // `panel` も `views` も省けるので、省略は既定（「ほかの一覧すべて」に区分なしのボタン）として読む
  const rows = Array.isArray(panel.views)
    ? (panel.views as unknown[]).filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    : [{ viewId: "*", sections: [""], menus: [] } as Record<string, unknown>];
  const namesOf = (row: Record<string, unknown>, key: "sections" | "menus"): string[] =>
    Array.isArray(row[key]) ? (row[key] as unknown[]).map((s) => String(s ?? "").trim()) : [];
  /** 一覧の行だけ（`viewId: "detail"` は詳細画面の行なので一覧には関係しない） */
  const listRows = rows.filter((r) => r.enabled !== false && String(r.viewId ?? "") !== "detail");
  const shown = new Set<string>();
  for (const row of listRows) {
    for (const n of namesOf(row, "sections")) shown.add(n);
    for (const n of namesOf(row, "menus")) shown.add(n);
  }
  const out: Finding[] = [];
  for (const [i, action] of actions.entries()) {
    if (action.enabled === false) continue;
    const onList = action.type === "app" || action.onList === true;
    if (!onList) continue;
    const name = String(action.panelSection ?? "").trim();
    const placements = Array.isArray(action.placements) ? action.placements.map((p) => String(p)) : [];
    const onDetail = placements.includes("detail_menu");
    const onEvent = placements.some((p) => p.startsWith("event_"));
    // 出る口がほかにあるものは黙る（詳細画面のボタン・イベント起動）
    if (onDetail || onEvent) continue;
    if (shown.has(name)) continue;
    const where = name === "" ? "区分なし（`\"\"`）" : `区分「${name}」`;
    const fix = name === ""
      ? "`panel.views` の行の `sections` に `\"\"` を足してください（例 `\"sections\": [\"\"]`）"
      : `\`panel.views\` の行の \`sections\`（パネル）か \`menus\`（メニュー）に「${name}」を足してください`;
    out.push({
      level: "warning",
      code: "wNowhereShown",
      message:
        `${where}のアクションですが、\`panel.views\` のどの一覧の行にも載っていないので`
        + "**どの一覧にも出ません**。`placements` に `detail_menu` もイベントも無いので、**どこにも出ません**。"
        + `${fix}（\`sections: []\` は「この一覧には何も出さない」で、「ぜんぶ出す」ではありません）`,
      actionIndex: i + 1,
      actionCode: String(action.code ?? ""),
    });
  }
  return out;
}

/**
 * 「項目が無い」と言われた名前が、**改名された擬似項目**なら、その旨を添える
 * （2026-11-07 の試用 S6）。
 *
 * 結果の変数は**オーサリング API 版 6（2026-11-06）で `_result_*` から `$result_*` に変わった**
 * （`_` は kintone の項目コードに使えるので、`_result_total` という項目があると黙って上書きされていた）。
 * **`migrateConfig` に書き換えは無い**ので、版 6 より前に作った設定はそのまま残る。
 * そのとき出るのは「`_result_total` という項目も関数も無い」で、**改名されたことが分からない**
 * （実際に 4377 の既存アクションで詰まった）。
 *
 * ループの `$val` / `$lno` も、口を間違えると同じ「項目が無い」になるので一緒に見る。
 */
function renameHint(name: string): string {
  if (/^_result_/i.test(name)) {
    return `。**結果の変数は \`$result_*\` に変わりました**（オーサリング API 版 6・2026-11-06）。`
      + `\`${name}\` は \`$${name.replace(/^_/, "")}\` と書きます`
      + `（古い設定は自動では直らないので、\`resultMessage\` を書き替えてください）`;
  }
  if (/^_(val|lno)$/i.test(name) || /^\$?(val|lno)$/i.test(name)) {
    return "。**`$val` / `$lno` はループ（`loop`）のパラメーターの式だけ**で使えます（ほかの口に書くと「項目が無い」になります。`kact_docs` の section loop）";
  }
  /**
   * 共通の文（§8.4。API 版 7）。コードが未定義か、書けない口に書いたときに
   * `message:unknown` / `message:slot` と**一緒に**この誤りが出る（文脈に `$m_…` が無いため）。
   * 「項目も関数も無い」だけだと項目コードの打ち間違いに見えるので、何の話かを添える
   * （2026-11-07 の試用 S10）。
   */
  if (/^\$?m_/i.test(name)) {
    return "。**共通の文（`messages`）のコード**です。"
      + "書けるのは **`execNgMessage` / `resultMessage` / `inputs[].optionLabelsFormula` の 3 つの口だけ**で、"
      + "**文そのものはツールからは足せません**（設定画面のツールバーの［メッセージ］で足してもらってください。"
      + "今あるコードは `kact_actions` の返りの `messages` で分かります）";
  }
  return "";
}

/** 行コメント（`--` から行末）を外した SQL。語の有無で判定するときに使う */
function sqlWithoutComments(sql: string): string {
  return sql.split(/\r?\n/).map((line) => line.replace(/--.*$/, "")).join("\n");
}

/**
 * 一覧の渡し方が「1 件ずつ」のまま、テーブルを全置換する `APPLY` を書いている
 * （2026-11-07 の試用 S5）。
 *
 * `REMOVE ALL ROWS; APPEND … SELECT` は**全置換**なので、1 件ずつ回すと
 * **後のレコードが前のレコードで入れた行を消す**。選んだレコードの親が全部違えば結果は正しいが、
 * **同じ親のものが 2 件以上あると最後の 1 件ぶんしか残らない**（`apply` の章が
 * 「『1 件ずつ』では成立しません」と書いている形そのもの）。
 *
 * ループ（`loop`）の同じ罠には `wLoopWriteNoFilter` という手がかりがあるのに、
 * **一覧の「1 件ずつ」には何も無かった**。しかも `selectionMode` の**既定が `"loop"`** なので、
 * 書き忘れただけでこの形になる（ループは `loop` を自分で書かないと起きない）。
 * 結果だけが静かに間違うので注意を出す（保存は止めない）。
 */
export function listApplyLoopFindings(actions: Array<Record<string, unknown>>): Finding[] {
  const out: Finding[] = [];
  for (const [i, action] of actions.entries()) {
    if (action.enabled === false) continue;
    if (action.onList !== true) continue;
    // 書かないときの既定が「1 件ずつ」
    if (String(action.selectionMode ?? "loop") !== "loop") continue;
    const sql = sqlWithoutComments(String(action.sql ?? ""));
    if (!/\bAPPLY\b/i.test(sql) || !/\bREMOVE\s+ALL\s+ROWS\b/i.test(sql)) continue;
    out.push({
      level: "warning",
      code: "wListApplyLoop",
      message:
        "一覧の渡し方が「1 件ずつ」（`selectionMode: \"loop\"`。**書かないときの既定**）のまま、"
        + "テーブルを全置換する `APPLY`（`REMOVE ALL ROWS`）を書いています。"
        + "選んだレコードに**同じ親のものが 2 件以上**あると、後のレコードが前のレコードで入れた行を消すので、"
        + "**最後の 1 件ぶんしか残りません**。"
        + "顧客ごと・部門ごとに分けるなら「グループごと」（`selectionMode: \"group\"` ＋ `groupFormula`）、"
        + "選んだ分をまとめて 1 つの親に入れるなら「まとめて 1 回」（`\"once\"`）にしてください"
        + "（`kact_docs` の section selection・apply）",
      actionIndex: i + 1,
      actionCode: String(action.code ?? ""),
    });
  }
  return out;
}

/**
 * SQL の中の**配列で宣言した変数**の名前（`DECLARE @keys = [];`）。
 * 実行計画はパラメーターを注入しないので、これらは空の配列として計画される。
 * `IN @keys` が `constant false` に見える理由を `kact_explain` の注記で伝えるために使う
 * （2026-11-06 の試用 S1。推奨の標準形がいつも全件取得のように見えていた）
 */
export function arrayDeclareNames(sql: string): string[] {
  const names: string[] = [];
  // 行コメント（`--`）の中は見ない。`DECLARE @名前 = [ … ]`（空でも要素があっても）を拾う
  for (const raw of sql.split(/\r?\n/)) {
    const line = raw.replace(/--.*$/, "");
    const m = /\bDECLARE\s+@([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\[/i.exec(line);
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/** 設定の中身を一覧（kact_actions）。**SQL 本文と値は返さない** */
export async function listActions(
  text: string,
  opt: LoadEngineOptions = {},
): Promise<{ status: ToolStatus; actions?: ActionSummary[]; messages?: string[]; findings: Finding[] }> {
  let engine: Engine;
  try {
    engine = await loadEngine(opt);
  } catch (e) {
    return { status: "failed", findings: [{ level: "error", code: "engine-load-failed", message: e instanceof Error ? e.message : String(e) }] };
  }
  let config: Record<string, unknown>;
  try {
    ({ config } = parseConfigFile(engine, text));
  } catch (e) {
    return { status: "invalid", findings: [{ level: "error", code: "parse-failed", message: e instanceof Error ? e.message : String(e) }] };
  }
  const actions = (Array.isArray(config.actions) ? config.actions : []) as Array<Record<string, unknown>>;
  /**
   * 共通の文の**コードの一覧だけ**（§8.4。文は返さない＝コードが分かれば式が書ける）。
   *
   * 2026-11-06 の試用 S3 で、**`panel` がツールから読めないために「黙って消える」実害**が出た。
   * `messages` で同じことを繰り返さないために、最初から返す。
   * **ツールからは足せない**（設定画面の［メッセージ］で足してもらう）ので、資料にもそう書く
   */
  const messages = (Array.isArray(config.messages) ? config.messages : [])
    .map((msg) => String((msg as { code?: unknown }).code ?? ""))
    .filter(Boolean);
  return {
    status: "ok",
    ...(messages.length > 0 ? { messages } : {}),
    actions: actions.map((a, i) => ({
      index: i + 1,
      code: String(a.code ?? ""),
      name: String(a.name ?? ""),
      enabled: a.enabled !== false,
      type: String(a.type ?? ""),
      onList: a.onList === true,
      placements: (Array.isArray(a.placements) ? a.placements : []).map(String),
      panelSection: String(a.panelSection ?? ""),
      // 渡し方は「一覧でも使う」のときだけ効く（2026-10-31 に種類 list をやめた）
      ...(a.onList === true ? { selectionMode: String(a.selectionMode ?? "loop") } : {}),
      // ループ（§5.7）。使っているアクションだけ返す（空なら従来どおり 1 回）
      ...(String(a.loop ?? "").trim() ? { loop: String(a.loop), loopOnError: String(a.loopOnError ?? "stop") } : {}),
      confirm: !!a.confirm,
      writeLimit: Number(a.writeLimit ?? 0),
      sqlLines: String(a.sql ?? "").split("\n").length,
      apply: /\bAPPLY\b/i.test(String(a.sql ?? "")),
      params: (Array.isArray(a.params) ? a.params : []).map((p) => String((p as { name?: unknown }).name ?? "")),
      inputs: (Array.isArray(a.inputs) ? a.inputs : []).map((p) => String((p as { name?: unknown }).name ?? "")),
    })),
    findings: [],
  };
}

/** ファイルから読む版（CLI と MCP の入口で使う。パスの検査は呼び出し側） */
export function readTextFile(file: string): string {
  return readFileSync(file, "utf8");
}

/**
 * 検査の問題を人が読める 1 行にする。
 *
 * **API 版 9 の zip では本体の `sqlProblemText` に作らせる**（設定画面に出る文と 1 字も違わない。
 * 文言の正本は本体の `src/config/problem-text.ts`）。版 8 までの zip では文言が公開されていないので、
 * これまでどおり `detail` と `kind` を並べる（`pInputTypeMismatch` が `"min / text"` のようになる）。
 *
 * **tools 側に文言を写さない。** 写すと本体の文と食い違い、直したつもりの文が画面と変わる
 * （ksql-action の CLAUDE.md「評価と判定のコードを tools に写させない」と同じ理由）。
 */
function problemMessage(
  engine: { api: unknown },
  p: { code: string; detail?: string; index?: number; kind?: string },
): string {
  const text = (engine.api as { sqlProblemText?: (problem: unknown, lang: string) => string }).sqlProblemText;
  if (typeof text === "function") {
    try {
      // tools の findings も資料も日本語なので `ja` で解く（語を選ばせる口は持たない）
      const s = text(p, "ja");
      if (typeof s === "string" && s.trim() !== "") return s;
    } catch {
      // 文を作れなくても検査は続ける（下の素の並びに落ちる）
    }
  }
  return [p.detail, p.index ? `文 ${p.index}` : "", p.kind].filter(Boolean).join(" / ") || p.code;
}
