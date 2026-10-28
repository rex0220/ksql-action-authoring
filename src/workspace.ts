/**
 * 作業フォルダーと、その中のファイルの安全な指し方（段階 1）。
 *
 * 約束（印刷屋の MCP と同じ）:
 * - ファイルは**作業フォルダーからの相対パスだけ**。`..`・絶対パス・ドライブ名は受けない
 * - **realpath で確かめる**（symlink・junction で外へ出るものは拒否）
 * - 作業フォルダーは起動の設定（環境変数）で決める。AI の引数では変えない
 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
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
