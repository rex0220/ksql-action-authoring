// フックの試験（claude plugin test）。**formula MCP の hooks/register.test.ts からの写し**（あちらが正本）。
// kact のフックは「直接の Write / Edit を止める」だけなので、仮のファイルの仕組みと、その判定だけを試す。
import { describe, expect, test } from 'claude-code/testing'

/** 仮のファイルの仕組み: フォルダーとファイルと symlink（/link → /ws/fields） */
const DIRS = new Set(['/ws', '/ws/settings', '/ws/fields', '/ws/fields/dev', '/ws/inbox', '/ws/src', '/ws/sub', '/other'])
const FILES = new Set(['/ws/settings/a.json', '/ws/src/x.ts'])
const LINKS: Record<string, string> = { '/link': '/ws/fields' }

/** Windows の Claude Code は $.fs.stat('/ws') を C:\ws に直してから渡すので、ドライブ名を外して区切りを / にそろえる */
const posix = (p: string) => p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

function fold(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  let joined = '/' + out.join('/')
  for (const [from, to] of Object.entries(LINKS)) if (joined === from || joined.startsWith(from + '/')) joined = to + joined.slice(from.length)
  return joined
}

type Setup = { session?: string; brokenRoot?: boolean }

/** 試験の on に、エンジンの代わりの答えを並べる。返り値は、下まで届いた tool.call の記録 */
function engine(on: any, { session = '/ws', brokenRoot = false }: Setup = {}) {
  const reached: Array<Record<string, unknown>> = []
  on('session.root', () => (brokenRoot ? { deny: 'root is broken' } : { value: session }))
  on('session.cwd', () => ({ value: session }))
  on('fs.stat', ($: unknown, e: { path: string }) => {
    const path = posix(e.path)
    const real = fold(path)
    const isLink = Object.keys(LINKS).some(l => path === l || path.startsWith(l + '/'))
    if (DIRS.has(real)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink, realPath: real } }
    if (FILES.has(real)) return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink, realPath: real } }
    return { deny: `ENOENT ${e.path}` }
  })
  on('tool.call', { tool: ['Write', 'Edit'] }, ($: unknown, e: Record<string, unknown>) => {
    reached.push(e)
    return { result: { type: 'create', filePath: e.file_path } }
  })
  return reached
}

const isDenied = (r: any) => r?.deny !== undefined || r?.isError === true
const denyText = (r: any) => String(r?.deny ?? r?.text ?? '')

describe('直接の Write / Edit を止める', () => {
  test('settings/*.json への Write を拒否し、保存のツールを案内する', async ($, on) => {
    const reached = engine(on)
    const r = await $.tool.call({ tool: 'Write', file_path: '/ws/settings/new.json', content: '{}' } as any)
    expect(isDenied(r)).toBe(true)
    expect(denyText(r)).toMatch(/kact_save_config/)
    expect(reached.length).toBe(0)
  })

  test('fields/ の下への Edit を拒否する（.. を含むパス）', async ($, on) => {
    engine(on)
    const r = await $.tool.call({ tool: 'Edit', file_path: '/ws/settings/../fields/dev/APP1001.json', old_string: 'a', new_string: 'b' } as any)
    expect(isDenied(r)).toBe(true)
    expect(denyText(r)).toMatch(/kact_fields/)
  })

  test('inbox/ への Write を拒否する（利用者が置くファイル）', async ($, on) => {
    engine(on)
    const r = await $.tool.call({ tool: 'Write', file_path: '/ws/inbox/x.json', content: '{}' } as any)
    expect(isDenied(r)).toBe(true)
  })

  test('symlink（/link → /ws/fields）を通した Write を拒否する', async ($, on) => {
    engine(on)
    const r = await $.tool.call({ tool: 'Write', file_path: '/link/dev/x.json', content: '{}' } as any)
    expect(isDenied(r)).toBe(true)
  })

  test('守る所でなければ通す（相対パスも、セッションのフォルダーの外も）', async ($, on) => {
    const reached = engine(on)
    for (const file_path of ['/ws/src/x.ts', 'src/x.ts', '/other/settings/a.json', '/ws/settings.json']) {
      const r = await $.tool.call({ tool: 'Write', file_path, content: 'x' } as any)
      expect(isDenied(r)).toBe(false)
    }
    expect(reached.length).toBe(4)
  })

  test('セッションのフォルダーが解決できなければ拒否する（fail-closed）', async ($, on) => {
    const reached = engine(on, { brokenRoot: true })
    const r = await $.tool.call({ tool: 'Write', file_path: '/ws/src/x.ts', content: 'x' } as any)
    expect(isDenied(r)).toBe(true)
    expect(reached.length).toBe(0)
  })
})
