/**
 * 作業フォルダーと、その中のファイルの安全な指し方（段階 1）。
 *
 * 約束（印刷屋の MCP と同じ）:
 * - ファイルは**作業フォルダーからの相対パスだけ**。`..`・絶対パス・ドライブ名は受けない
 * - **realpath で確かめる**（symlink・junction で外へ出るものは拒否）
 * - 作業フォルダーは起動の設定（環境変数）で決める。AI の引数では変えない
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export class WorkspaceError extends Error {
  constructor(message: string, readonly code: "not-configured" | "not-found" | "outside" | "not-file") {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** 起動の設定から作業フォルダーを決める（`KACT_WORKSPACE`。無ければ今のフォルダー） */
export function workspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.KACT_WORKSPACE?.trim() || process.cwd();
  if (!existsSync(dir)) throw new WorkspaceError(`作業フォルダーが無い: ${dir}`, "not-found");
  return realpathSync(dir);
}

/** 作業フォルダーの中のファイルの実パス。相対パスだけを受け、realpath で外に出ていないか確かめる */
export function resolveInWorkspace(relative: string, dir = workspaceDir()): string {
  if (!relative || typeof relative !== "string") throw new WorkspaceError("ファイルの指定が無い", "not-found");
  if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) {
    throw new WorkspaceError("ファイルは作業フォルダーからの相対パスで指定する（絶対パスは受けない）", "outside");
  }
  const joined = path.resolve(dir, relative);
  if (!existsSync(joined)) throw new WorkspaceError(`ファイルが無い: ${relative}`, "not-found");
  const real = realpathSync(joined);
  const realDir = realpathSync(dir);
  if (real !== realDir && !real.startsWith(realDir + path.sep)) {
    throw new WorkspaceError("作業フォルダーの外は読めない（symlink の先を含む）", "outside");
  }
  if (!statSync(real).isFile()) throw new WorkspaceError(`ファイルではない: ${relative}`, "not-file");
  return real;
}

export interface WorkspaceStatus {
  dir: string;
  /** 作業フォルダーの直下にある設定ファイルらしきもの（*.json。中身は見ない） */
  files: string[];
  /** zip の場所が設定されているか（値は出さない） */
  pluginZipConfigured: boolean;
}

/** 作業フォルダーの診断（kact_workspace_status）。秘密の値は出さない */
export function workspaceStatus(env: NodeJS.ProcessEnv = process.env): WorkspaceStatus {
  const dir = workspaceDir(env);
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".json"))
    .map((d) => d.name)
    .slice(0, 50);
  return { dir, files, pluginZipConfigured: !!env.KACT_PLUGIN_ZIP?.trim() };
}

/** 書く先の上限（設定ファイルは大きくても数十 KB。プラグイン設定の上限は 256 KB） */
export const MAX_CONFIG_BYTES = 512 * 1024;

/**
 * **これから書く**ファイルの実パス（kact_save_config / kact_pull）。読むときの resolveInWorkspace と違い、
 * ファイルはまだ無くてよい。**親フォルダー**が作業フォルダーの中にあることを realpath で確かめる（symlink で外に出る先に書かない）。
 * 親フォルダーが無ければ作る（作業フォルダーの中だと確かめた後だけ）。
 */
export function resolveNewInWorkspace(relative: string, dir = workspaceDir()): string {
  if (!relative || typeof relative !== "string") throw new WorkspaceError("ファイルの指定が無い", "not-found");
  if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) {
    throw new WorkspaceError("ファイルは作業フォルダーからの相対パスで指定する（絶対パスは受けない）", "outside");
  }
  if (!/\.json$/i.test(relative)) throw new WorkspaceError("設定ファイルの名前は .json で終える", "not-file");
  const realDir = realpathSync(dir);
  const joined = path.resolve(realDir, relative);
  const inside = (p: string): boolean => p === realDir || p.startsWith(realDir + path.sep);
  if (!inside(joined)) throw new WorkspaceError("作業フォルダーの外には書けない", "outside");
  // 親フォルダー: ある分だけ realpath で確かめ、無い分は作る（作業フォルダーの中だと分かってから）
  const parent = path.dirname(joined);
  let exists = parent;
  while (!existsSync(exists)) exists = path.dirname(exists);
  if (!inside(realpathSync(exists))) throw new WorkspaceError("作業フォルダーの外には書けない（symlink の先を含む）", "outside");
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  else if (!inside(realpathSync(parent))) throw new WorkspaceError("作業フォルダーの外には書けない（symlink の先を含む）", "outside");
  return joined;
}

export interface WorkspaceFile {
  /** 作業フォルダーからの相対パス */
  path: string;
  bytes: number;
  /** 最後に変わった日時（ISO 8601） */
  modified: string;
}

/** 作業フォルダーの JSON を集める（深さ 3 まで。中身は読まない）。node_modules などは見ない */
export function listWorkspaceFiles(dir = workspaceDir(), maxDepth = 3, limit = 200): WorkspaceFile[] {
  const out: WorkspaceFile[] = [];
  const skip = new Set(["node_modules", ".git", ".claude", "dist"]);
  const walk = (abs: string, rel: string, depth: number): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return;
      if (entry.name.startsWith(".") || skip.has(entry.name)) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(childAbs, childRel, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        const st = statSync(childAbs);
        out.push({ path: childRel, bytes: st.size, modified: new Date(st.mtimeMs).toISOString() });
      }
    }
  };
  walk(realpathSync(dir), "", 1);
  return out;
}
