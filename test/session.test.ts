/**
 * 会话门面测试：真实 JsonlMemoryStore 上的完整操作闭环
 * （编辑 / 检索 facets / 取代 / 删除 / 导入导出 / 加密口令全生命周期）
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, probeLibrary, cleanTags } from '../src/main/session'
import { JsonlMemoryStore, isSuperseded, supersededByTargetId } from 'dsh-memory-hub/core'

let dir: string
let libPath: string
let session: SessionManager

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mhub-session-'))
  libPath = join(dir, 'memories.jsonl')
  session = new SessionManager()
})

afterEach(async () => {
  await session.close()
  await rm(dir, { recursive: true, force: true })
})

describe('SessionManager 基础编辑闭环', () => {
  it('create → list → update → delete 全链', async () => {
    await session.open(libPath)
    const e1 = await session.create({
      content: '项目 X 的构建命令是 pnpm build',
      kind: 'fact',
      tags: ['构建', '项目X'],
    })
    const e2 = await session.create({ content: '用户偏好中文注释', kind: 'preference' })
    expect((await session.list({})).total).toBe(2)

    const updated = await session.update({
      id: e1.id,
      content: '项目 X 的构建命令是 pnpm build --filter core',
      tags: ['构建'],
    })
    expect(updated.content).toContain('--filter core')
    expect(updated.createdAt).toBe(e1.createdAt) // 创建时间不推进
    expect(updated.updatedAt).toBeGreaterThanOrEqual(e1.updatedAt)

    expect(await session.remove([e2.id])).toBe(1)
    expect((await session.list({})).total).toBe(1)
  })

  it('空内容 / 敏感内容与插件同一防线', async () => {
    await session.open(libPath)
    await expect(session.create({ content: '   ' })).rejects.toMatchObject({ kind: 'EMPTY_CONTENT' })
    await expect(session.create({ content: '数据库密钥是 sk-abcdef0123456789abcdef，不要外传' })).rejects.toMatchObject(
      {
        kind: 'SENSITIVE_CONTENT',
      },
    )
  })

  it('编辑不存在的条目显式 NOT_FOUND', async () => {
    await session.open(libPath)
    await expect(session.update({ id: 'nonexistent', content: 'x'.repeat(20) })).rejects.toMatchObject({
      kind: 'NOT_FOUND',
    })
  })

  it('检索：命中排序 + facets 维度', async () => {
    await session.open(libPath)
    await session.create({ content: '构建命令是 pnpm build，入口在 package.json', kind: 'fact', tags: ['构建'] })
    await session.create({ content: '部署到生产环境前必须跑全量测试', kind: 'instruction', tags: ['部署'] })
    await session.create({ content: '用户偏好暗色主题界面', kind: 'preference', tags: ['ui'] })
    const r = await session.list({ query: '构建命令' })
    expect(r.searched).toBe(true)
    expect(r.items.length).toBeGreaterThanOrEqual(1)
    expect(r.items[0].score).toBeGreaterThan(0)
    expect(r.facets.total).toBe(3)
    expect(r.facets.byKind.fact).toBe(1)
    expect(r.facets.byTag.some((t) => t.tag === '构建')).toBe(true)
  })

  it('取代协议：新条目 supersede 旧条目 superseded-by', async () => {
    await session.open(libPath)
    const old = await session.create({ content: '数据库用 MySQL 5.7', kind: 'fact' })
    const { newEntry, oldEntry } = await session.supersede({ id: old.id, content: '数据库已迁移到 PostgreSQL 16' })
    expect(newEntry.tags).toContain(`supersede:${old.id}`)
    expect(supersededByTargetId(oldEntry)).toBe(newEntry.id)
    const stored = await session.get(old.id)
    expect(isSuperseded(stored!)).toBe(true)
  })
})

describe('导入导出闭环', () => {
  it('markdown 导入预览 → 提交 → 二次幂等', async () => {
    await session.open(libPath)
    const md = join(dir, 'notes.md')
    await writeFile(
      md,
      '# 项目笔记\n\n构建命令是 pnpm build，测试是 vitest。\n\n部署前必须跑全量测试套件。\n\n短。\n',
      'utf8',
    )
    const preview = await session.importPreview({ kind: 'markdown', path: md, mode: 'balanced' })
    expect(preview.planned).toBe(2)
    expect(preview.stats.droppedShort).toBeGreaterThanOrEqual(1)

    const commit = await session.importCommit({ kind: 'markdown', path: md, mode: 'balanced' })
    expect(commit.imported).toBe(2)
    // 内容级幂等：重复导入全部去重
    const again = await session.importCommit({ kind: 'markdown', path: md, mode: 'balanced' })
    expect(again.imported).toBe(0)
  })

  it('JSON 导出 → 新库导入 = 迁移闭环', async () => {
    await session.open(libPath)
    await session.create({ content: '跨设备迁移的第一条记忆', kind: 'fact' })
    await session.create({ content: '跨设备迁移的第二条记忆', kind: 'decision' })
    const json = await session.exportJson()
    const target = join(dir, 'export.json')
    await writeFile(target, json, 'utf8')
    expect(JSON.parse(json).length).toBe(2)

    const other = join(dir, 'other.jsonl')
    await session.open(other)
    const preview = await session.importPreview({ kind: 'json', path: target })
    expect(preview.planned).toBe(2)
    const commit = await session.importCommit({ kind: 'json', path: target })
    expect(commit.imported).toBe(2)
    expect((await session.list({})).total).toBe(2)
    // id 级幂等
    expect((await session.importCommit({ kind: 'json', path: target })).imported).toBe(0)
  })

  it('会话 JSONL 导入：损坏行计数', async () => {
    await session.open(libPath)
    const lines = [
      JSON.stringify({
        type: 'user/message',
        data: { content: [{ type: 'text', text: '记住项目部署用 pnpm deploy，需要先跑全量测试' }] },
      }),
      '{broken',
    ]
    const src = join(dir, 'session.jsonl')
    await writeFile(src, lines.join('\n'), 'utf8')
    const preview = await session.importPreview({ kind: 'session', path: src })
    expect(preview.stats.corruptLines).toBe(1)
    expect(preview.planned).toBe(1)
  })

  it('HTML 可视化页导出（自包含）', async () => {
    await session.open(libPath)
    await session.create({ content: '可视化导出的样例记忆条目内容' })
    const html = await session.exportHtml()
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('window.__MH__')
    expect(html).not.toMatch(/src="https?:/)
  })

  it('status：统计 / 主题 / 时间轴 / 诊断', async () => {
    await session.open(libPath)
    await session.create({ content: '统计视图的第一条记忆条目', kind: 'fact', tags: ['统计'] })
    await session.create({ content: '统计视图的第二条记忆条目', kind: 'fact', tags: ['统计'] })
    const status = await session.status()
    expect(status.stats.total).toBe(2)
    expect(status.stats.byKind.fact).toBe(2)
    expect(status.timeline.buckets.length).toBeGreaterThanOrEqual(1)
    expect(status.diagnostics.lines).toBeGreaterThanOrEqual(2)
    expect(status.themes.length).toBeGreaterThanOrEqual(0)
  })
})

describe('加密口令全生命周期', () => {
  it('加密 → 锁定 → 缺口令/错口令 → 解锁 → 轮换 → 解密回退', async () => {
    await session.open(libPath)
    await session.create({ content: '加密生命周期的受保护记忆内容' })

    // 启用加密（明文库原位迁移）
    await session.changePassphrase('first-pass')
    expect(session.unlockedEncrypted).toBe(true)
    expect((await probeLibrary(libPath)).encrypted).toBe(true)

    // 锁定后：缺口令显式失败
    await session.lock()
    await expect(session.open(libPath)).rejects.toMatchObject({ kind: 'NEEDS_PASSPHRASE' })

    // 错口令
    await expect(session.open(libPath, { passphrase: 'wrong' })).rejects.toMatchObject({ kind: 'WRONG_PASSPHRASE' })

    // 正确口令解锁后可读写
    await session.open(libPath, { passphrase: 'first-pass' })
    expect((await session.list({})).total).toBe(1)
    await session.create({ content: '解锁后写入的第二条加密记忆' })
    expect((await session.list({})).total).toBe(2)

    // 轮换 → 新口令生效
    await session.changePassphrase('second-pass')
    await session.lock()
    await expect(session.open(libPath, { passphrase: 'first-pass' })).rejects.toMatchObject({
      kind: 'WRONG_PASSPHRASE',
    })
    await session.open(libPath, { passphrase: 'second-pass' })
    expect((await session.list({})).total).toBe(2)

    // 解密回退 → 明文库无口令可开
    await session.changePassphrase('')
    await session.lock()
    await session.open(libPath)
    expect((await probeLibrary(libPath)).encrypted).toBe(false)
    expect((await session.list({})).total).toBe(2)
  })

  it('密文落盘：文件内容不含明文', async () => {
    await session.open(libPath)
    const secret = '绝密记忆内容不应以明文出现在磁盘上'
    await session.create({ content: secret })
    await session.changePassphrase('pp')
    const raw = await readFile(libPath, 'utf8')
    expect(raw).not.toContain(secret)
    // 且可被原生 store 以口令读回（协议兼容）
    const store = await JsonlMemoryStore.open(libPath, undefined, { passphrase: 'pp' })
    expect((await store.list()).length).toBe(1)
    await store.close()
  })
})

describe('cleanTags', () => {
  it('trim / 去空 / 去重保序', () => {
    expect(cleanTags([' a ', '', 'a', 'b'])).toEqual(['a', 'b'])
  })
})
