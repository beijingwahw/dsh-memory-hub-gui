/**
 * IPC 契约测试：入参校验（畸形载荷显式失败）+ 桥装配端到端（含对话框替身）
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge, toIpcError } from '../src/main/ipc'
import { LibraryRegistry } from '../src/main/registry'
import { SessionManager, SessionError } from '../src/main/session'
import { Channels, Validators, ValidationError } from '../src/shared/protocol'

let dir: string
let session: SessionManager
let bridge: Map<string, (payload: unknown) => Promise<unknown>>
const written = new Map<string, string>()

const dialogs = {
  async pickOpen(): Promise<string | undefined> {
    return join(dir, 'sample.md')
  },
  async pickSave(_kind: 'json' | 'html', defaultName: string): Promise<string | undefined> {
    return join(dir, defaultName)
  },
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mhub-ipc-'))
  session = new SessionManager()
  const registry = await LibraryRegistry.load(join(dir, 'libraries.json'), { defaultPath: join(dir, 'memories.jsonl') })
  bridge = createBridge({
    registry,
    session,
    dialogs,
    writeFile: async (path, data) => {
      written.set(path, data)
    },
  })
  await writeFile(join(dir, 'sample.md'), '# 样例\n\n构建命令是 pnpm build 且必须全量测试通过。\n', 'utf8')
})

afterEach(async () => {
  await session.close()
  await rm(dir, { recursive: true, force: true })
  written.clear()
})

const call = async (channel: string, payload?: unknown): Promise<unknown> => {
  const handler = bridge.get(channel)
  if (handler === undefined) throw new Error(`no handler: ${channel}`)
  return handler(payload ?? {})
}

describe('Validators（畸形载荷防御）', () => {
  it('entryCreate 必须有 content 且有限长', () => {
    expect(() => Validators.entryCreate({})).toThrow(ValidationError)
    expect(() => Validators.entryCreate({ content: 42 })).toThrow(ValidationError)
    expect(Validators.entryCreate({ content: 'ok content' })).toMatchObject({ content: 'ok content' })
    expect(() => Validators.entryCreate({ content: 'x'.repeat(20_001) })).toThrow(ValidationError)
    expect(() => Validators.entryCreate({ content: 'ok', kind: 'nope' })).toThrow(ValidationError)
    expect(() => Validators.entryCreate({ content: 'ok', tags: [1, 2] })).toThrow(ValidationError)
  })

  it('entryDelete 必须非空 id 数组', () => {
    expect(() => Validators.entryDelete({})).toThrow(ValidationError)
    expect(() => Validators.entryDelete({ ids: [] })).toThrow(ValidationError)
    expect(Validators.entryDelete({ ids: ['a'] })).toMatchObject({ ids: ['a'] })
  })

  it('entryList 数值边界', () => {
    expect(() => Validators.entryList({ limit: 0 })).toThrow(ValidationError)
    expect(() => Validators.entryList({ limit: 999999 })).toThrow(ValidationError)
    expect(() => Validators.entryList({ offset: -1 })).toThrow(ValidationError)
    expect(Validators.entryList({ limit: 50, offset: 100 })).toMatchObject({ limit: 50, offset: 100 })
  })

  it('libPassphrase 只接受字符串', () => {
    expect(() => Validators.libPassphrase({ next: 123 })).toThrow(ValidationError)
    expect(Validators.libPassphrase({})).toMatchObject({ next: '' })
  })
})

describe('桥端到端（真实 store）', () => {
  it('libList → 默认库在列；libCreate → libActivate 切换', async () => {
    const initial = (await call(Channels.libList)) as Array<{ isDefault?: boolean; active: boolean }>
    expect(initial.some((l) => l.isDefault)).toBe(true)
    // 默认库未激活（显式 activate 才打开）
    expect(initial.every((l) => !l.active)).toBe(true)

    const created = (await call(Channels.libCreate, { filePath: join(dir, 'sub', 'new.jsonl') })) as Array<{
      active: boolean
      open?: { entryCount: number }
    }>
    expect(created.some((l) => l.active && l.open?.entryCount === 0)).toBe(true)
  })

  it('entryCreate → entryList → entryUpdate → entrySupersede → entryDelete', async () => {
    await call(Channels.libActivate, {
      id: ((await call(Channels.libList)) as Array<{ id: string; isDefault?: boolean }>)[0].id,
    })
    const entry = (await call(Channels.entryCreate, {
      content: '桥端到端的第一条记忆内容',
      kind: 'fact',
      tags: ['e2e'],
    })) as { id: string }
    const list = (await call(Channels.entryList, { query: '桥端到端' })) as {
      total: number
      searched: boolean
      items: Array<{ id: string }>
    }
    expect(list.searched).toBe(true)
    expect(list.items[0].id).toBe(entry.id)

    const updated = (await call(Channels.entryUpdate, { id: entry.id, content: '桥端到端的第二条改写内容' })) as {
      content: string
    }
    expect(updated.content).toContain('第二条改写')

    const sup = (await call(Channels.entrySupersede, { id: entry.id, content: '桥端到端的取代版本内容' })) as {
      newEntry: { id: string }
    }
    expect(sup.newEntry.id).not.toBe(entry.id)

    const removed = (await call(Channels.entryDelete, { ids: [entry.id, sup.newEntry.id] })) as number
    expect(removed).toBe(2)
  })

  it('导入预览/提交 + 导出 json/html（对话框替身路径）', async () => {
    const libs = (await call(Channels.libList)) as Array<{ id: string }>
    await call(Channels.libActivate, { id: libs[0].id })
    const preview = (await call(Channels.ioImportPreview, { kind: 'markdown', path: join(dir, 'sample.md') })) as {
      planned: number
    }
    expect(preview.planned).toBeGreaterThanOrEqual(1)
    const commit = (await call(Channels.ioImportCommit, { kind: 'markdown', path: join(dir, 'sample.md') })) as {
      imported: number
    }
    expect(commit.imported).toBeGreaterThanOrEqual(1)

    const exported = (await call(Channels.ioExportJson, { path: join(dir, 'out.json') })) as {
      count: number
      bytes: number
    }
    expect(exported.count).toBeGreaterThanOrEqual(1)
    expect(exported.bytes).toBeGreaterThan(50)
    expect(written.get(join(dir, 'out.json'))).toContain('[')

    const html = (await call(Channels.ioExportHtml, { path: join(dir, 'out.html') })) as { bytes: number }
    expect(html.bytes).toBeGreaterThan(1000)
    expect(written.get(join(dir, 'out.html'))).toContain('<!doctype html>')
  })

  it('锁库 → 再操作显式失败 → toIpcError 结构化', async () => {
    const libs = (await call(Channels.libList)) as Array<{ id: string }>
    await call(Channels.libActivate, { id: libs[0].id })
    await call(Channels.libLock)
    const err = await call(Channels.entryList, {}).catch((e: unknown) => e as SessionError)
    expect(err).toBeInstanceOf(SessionError)
    const ipcErr = toIpcError(err)
    expect(ipcErr.code).toBe('NO_ACTIVE_LIBRARY')
    expect(ipcErr.message).toContain('没有打开的记忆库')
  })

  it('加密库激活：缺口令 → 口令解锁（桥级）', async () => {
    // 先建库 + 加密
    await call(Channels.libCreate, { filePath: join(dir, 'enc.jsonl') })
    await call(Channels.entryCreate, { content: '加密库里的受保护记忆内容' })
    await call(Channels.libPassphrase, { next: 'pp' })
    await call(Channels.libLock)
    const libs = (await call(Channels.libList)) as Array<{ id: string; encrypted: boolean; active: boolean }>
    const enc = libs.find((l) => l.encrypted)!
    await expect(call(Channels.libActivate, { id: enc.id })).rejects.toMatchObject({ kind: 'NEEDS_PASSPHRASE' })
    await call(Channels.libActivate, { id: enc.id, passphrase: 'pp' })
    const list = (await call(Channels.entryList, {})) as { total: number }
    expect(list.total).toBe(1)
  })
})

describe('toIpcError', () => {
  it('Node 文件错误 → IO_ERROR', () => {
    const err = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    expect(toIpcError(err).code).toBe('IO_ERROR')
  })

  it('未知错误 → INTERNAL', () => {
    expect(toIpcError('boom').code).toBe('INTERNAL')
    expect(toIpcError(new Error('plain')).message).toBe('plain')
  })
})
