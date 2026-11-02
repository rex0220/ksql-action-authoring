// kact（kSQL アクションのオーサリング）のための Claude Code のフック。
// **formula MCP の hooks/register.ts からの写し**（あちらが正本。パスを解決する助けの関数はそのまま）。
// 写したのは「直接の書き込みを止める」ところだけで、作業フォルダーの登録（workspaceId の書き換え）は入れていない:
//   kact のツールは作業フォルダーを引数で受けず、起動の環境変数（`KACT_WORKSPACE`。省略時は起動したフォルダー）で決まるため。
//   - 直接の Write / Edit で `settings/**/*.json`・`fields/**`・`inbox/**` を変えるのを拒否する
//     （設定ファイルは `kact_save_config` / `kact_update_action` から、控えは `kact_fields`、ダウンロードは利用者が置く）
//   - セッションのフォルダーの外は止めない（kSQL アクションと関係のないファイル）
//   - 拒否のフックは .catch で失敗を拒否にする（fail-closed）
import type { EngineInterface, Register } from 'claude-code'

type $ = EngineInterface

/** 直接の Write / Edit を拒否するパス（セッションのフォルダーからの相対。区切りは / にそろえる） */
const PROTECTED: Array<[RegExp, string]> = [
  [/^settings\/.+\.json$/i, 'kact_save_config / kact_update_action で保存する（上書きしない・digest で照合する決まりを通す）'],
  [/^fields(\/|$)/, 'kact_fields が取る kintone の項目定義の控え（手で書かない）'],
  [/^inbox(\/|$)/, '設定画面の［設定をダウンロード］で利用者が置くファイル（AI が作らない）'],
]

const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p)
const sepOf = (p: string) => (isWindowsPath(p) ? '\\' : '/')
const foldCase = (p: string) => (isWindowsPath(p) ? p.toLowerCase() : p)
const trimSep = (p: string) => p.replace(/[\\/]+$/, '') || p

/** パスを実際のパス（symlink を解く）に直す。フォルダーだけ。だめなら undefined */
async function realDir($: $, p: string): Promise<string | undefined> {
  const st = await $.fs.stat(p, { resolve: true }).catch(() => undefined)
  return st?.kind === 'dir' && st.realPath ? foldCase(trimSep(st.realPath)) : undefined
}

/**
 * Write がまだ無いファイル・フォルダーを指してもよいように、着地する実際のパスを返す。
 * パスの . と .. を字面でたたんでから、存在する一番深い親を実際のパス（symlink を解く）に直し、残りをつなげる。
 * ドライブ相対・ネットワーク（\\ や //）・空・. / .. の名前は解決しない（undefined → 拒否）
 */
async function placed($: $, p: string): Promise<string | undefined> {
  if (/^[A-Za-z]:(?![\\/])/.test(p) || /^[\\/][\\/]/.test(p)) return undefined
  const sep = sepOf(p)
  const drive = /^[A-Za-z]:/.test(p) ? p.slice(0, 2) : ''
  const parts: string[] = []
  for (const part of p.slice(drive.length).split(/[\\/]/)) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  const name = parts[parts.length - 1]
  if (name === undefined || /^[A-Za-z]:/.test(name)) return undefined
  // 一番深い存在する親を探す（ファイルそのものから順にさかのぼる）
  for (let i = parts.length; i >= 0; i--) {
    const head = `${drive}${sep}${parts.slice(0, i).join(sep)}`
    const st = await $.fs.stat(head, { resolve: true }).catch(() => undefined)
    if (st?.realPath === undefined) continue
    const rest = parts.slice(i)
    if (rest.length > 0 && st.kind !== 'dir') return undefined // ファイルの下には置けない
    const base = trimSep(st.realPath)
    return foldCase(rest.length === 0 ? base : `${base}${sepOf(base)}${rest.join(sepOf(base))}`)
  }
  return undefined
}

const isUnder = (child: string, parent: string) => child === parent || child.startsWith(parent + sepOf(parent))

export const register: Register = (on) => {
  // 直接の Write / Edit で設定ファイル・控え・ダウンロードを変えない
  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const filePath = String((e as { file_path?: unknown }).file_path ?? '')
    const base = await realDir($, await $.session.root())
    if (base === undefined) return { deny: 'kact: セッションのフォルダーを解決できない' }
    const absolute = isWindowsPath(filePath) || filePath.startsWith('/') ? filePath : `${await $.session.cwd()}${sepOf(base)}${filePath}`
    const real = await placed($, absolute)
    if (real === undefined) return { deny: 'kact: 書き込む先を解決できない' }
    if (!isUnder(real, base)) return next(e) // セッションのフォルダーの外は止めない
    const rel = real.slice(base.length + 1).replace(/\\/g, '/')
    const hit = PROTECTED.find(([re]) => re.test(rel))
    if (hit) return { deny: `kact: ${rel} は直接書き換えない。${hit[1]}` }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'kact: 書き込む先の確認に失敗した' }))
}
