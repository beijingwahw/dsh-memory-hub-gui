/**
 * 多库注册表测试：默认库注入 / 增删改 / 去重 / 原子持久化往返 / 损坏回退
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { LibraryRegistry, RegistryError, normalizePath, defaultLibraryPath } from '../src/main/registry'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mhub-registry-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('LibraryRegistry', () => {
  it('默认库自动注入且不可移除', async () => {
    const reg = await LibraryRegistry.load(join(dir, 'libraries.json'))
    const libs = reg.list()
    expect(libs.length).toBe(1)
    expect(libs[0].isDefault).toBe(true)
    expect(normalizePath(libs[0].filePath)).toBe(normalizePath(defaultLibraryPath()))
    await expect(reg.remove(libs[0].id)).rejects.toMatchObject({ code: 'DEFAULT_IMMUTABLE' })
  })

  it('add / create / rename / remove 持久化往返', async () => {
    const jsonPath = join(dir, 'libraries.json')
    const reg = await LibraryRegistry.load(jsonPath)
    const a = await reg.add(join(dir, 'work.jsonl'), '工作库')
    const b = await reg.create(join(dir, 'nested', 'personal.jsonl'))
    expect(reg.list().length).toBe(3)

    // 重新加载：记录完整恢复
    const reg2 = await LibraryRegistry.load(jsonPath)
    expect(reg2.list().map((l) => l.name)).toContain('工作库')
    expect(reg2.get(b.id)?.filePath).toBe(b.filePath)

    await reg2.rename(b.id, '  私人库  ')
    expect(reg2.get(b.id)?.name).toBe('私人库')
    await reg2.remove(a.id)
    expect(reg2.list().length).toBe(2)

    const reg3 = await LibraryRegistry.load(jsonPath)
    expect(reg3.list().length).toBe(2)
    expect(stat(join(dir, 'nested')).then(() => true)).resolves.toBe(true)
  })

  it('重复路径与非法路径显式拒绝', async () => {
    const reg = await LibraryRegistry.load(join(dir, 'libraries.json'))
    await reg.add(join(dir, 'dup.jsonl'))
    await expect(reg.add(join(dir, 'dup.jsonl'))).rejects.toMatchObject({ code: 'DUPLICATE_LIBRARY' })
    await expect(reg.add(join(dir, 'not-jsonl.txt'))).rejects.toBeInstanceOf(RegistryError)
    await expect(reg.create(join(dir, 'bad.txt'))).rejects.toMatchObject({ code: 'INVALID_PATH' })
  })

  it('create 拒绝覆盖既有非空库（防误覆盖）', async () => {
    const reg = await LibraryRegistry.load(join(dir, 'libraries.json'))
    const existing = join(dir, 'existing.jsonl')
    await writeFile(existing, '{"id":"x"}\n', 'utf8')
    await expect(reg.create(existing)).rejects.toMatchObject({ code: 'LIBRARY_EXISTS' })
    // 空文件可以接管
    const empty = join(dir, 'empty.jsonl')
    await writeFile(empty, '', 'utf8')
    await expect(reg.create(empty)).resolves.toBeTruthy()
  })

  it('损坏注册表回退 .bak 留证并重建默认库', async () => {
    const jsonPath = join(dir, 'libraries.json')
    await writeFile(jsonPath, '{broken json!!', 'utf8')
    const reg = await LibraryRegistry.load(jsonPath)
    expect(reg.list().length).toBe(1)
    expect(reg.list()[0].isDefault).toBe(true)
    const bak = await readFile(`${jsonPath}.bak`, 'utf8').catch(() => '')
    expect(bak).toContain('broken')
  })

  it('touch 记录打开时间并持久化', async () => {
    const jsonPath = join(dir, 'libraries.json')
    const reg = await LibraryRegistry.load(jsonPath)
    const rec = await reg.add(join(dir, 't.jsonl'))
    const t0 = Date.now()
    reg.touch(rec.id)
    expect(reg.get(rec.id)?.lastOpenedAt).toBeGreaterThanOrEqual(t0 - 5)
    await reg.save()
    const reg2 = await LibraryRegistry.load(jsonPath)
    expect(reg2.get(rec.id)?.lastOpenedAt).toBe(reg.get(rec.id)?.lastOpenedAt)
  })
})

describe('normalizePath', () => {
  it('分隔符归一 + 尾分隔符剥离（跨平台去重键稳定）', () => {
    const a = normalizePath(join(dir, 'x', 'y'))
    const b = normalizePath(`${join(dir, 'x', 'y')}${sep}`)
    expect(a).toBe(b)
    expect(a.includes('/')).toBe(process.platform === 'win32' ? false : true)
  })
})
