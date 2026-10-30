/**
 * 会话门面：GUI 的全部记忆库操作面（打开 / 编辑 / 检索 / 导入导出 / 口令）
 *
 * - 领域语义全部委托 dsh-memory-hub/core（./core 子路径导出）——GUI 不复制任何
 *   存储或检索实现；
 * - 口令只在主进程内存中持有（打开期间），不落盘、不打印、不进入任何日志；
 * - 纯 Node 模块（零 Electron 依赖），vitest 直接实例化真实 JsonlMemoryStore 测试；
 * - 语义对齐插件工具层：创建/编辑与 memory_store 同一条敏感过滤防线
 *   （containsSensitive + makeEntry maxChars=1000 + 空内容显式失败）。
 */
import { open as fsOpen, stat, readFile } from 'node:fs/promises'
import { JsonlMemoryStore, MemoryHubError, ErrorCodes } from 'dsh-memory-hub/core'
import {
  containsSensitive,
  makeEntry,
  parseKeyRecord,
  recall,
  renderMemoryHtml,
  safeSlice,
  clusterThemes,
  summarize,
  planImport,
  toMemoryEntry,
  SUPERSEDE_TAG_PREFIX,
  SUPERSEDED_BY_TAG_PREFIX,
  type MemoryEntry,
  type MemoryKind,
} from 'dsh-memory-hub/core'
import type {
  CreateParams,
  Facets,
  ImportCommitResult,
  ImportParams,
  ImportPreviewResult,
  ListItemHit,
  ListParams,
  ListResult,
  StatusResult,
  SupersedeParams,
  UpdateParams,
} from '../shared/protocol'

/** 与插件 maxEntryChars 缺省一致（config.ts defaultConfig.maxEntryChars = 1000） */
export const MAX_ENTRY_CHARS = 1000

export class SessionError extends Error {
  constructor(
    readonly kind:
      | 'NEEDS_PASSPHRASE'
      | 'WRONG_PASSPHRASE'
      | 'EMPTY_CONTENT'
      | 'SENSITIVE_CONTENT'
      | 'NOT_FOUND'
      | 'NO_ACTIVE_LIBRARY'
      | 'IO',
    message: string,
  ) {
    super(message)
    this.name = 'SessionError'
  }
}

/** 磁盘探测：存在性 / 加密形态 / 体量（只读首 KB 判定密钥记录头，不整读文件） */
export async function probeLibrary(filePath: string): Promise<{ exists: boolean; encrypted: boolean; bytes: number }> {
  const st = await stat(filePath).catch(() => undefined)
  if (!st) return { exists: false, encrypted: false, bytes: 0 }
  let head = ''
  try {
    const fh = await fsOpen(filePath, 'r')
    try {
      const buf = Buffer.alloc(1024)
      const { bytesRead } = await fh.read(buf, 0, 1024, 0)
      head = buf.toString('utf8', 0, bytesRead)
    } finally {
      await fh.close()
    }
  } catch {
    /* 读取失败按明文处理——open 阶段会给出真正错误 */
  }
  const firstLine = head.split('\n').find((l) => l.trim())
  return {
    exists: true,
    encrypted: firstLine !== undefined && parseKeyRecord(firstLine.trim()) !== undefined,
    bytes: st.size,
  }
}

/** makeEntry 同款 tags 清洗（trim / 去空 / 去重，保序） */
export function cleanTags(tags: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of tags) {
    const t = raw.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

function assertContent(content: string): string {
  const trimmed = content.trim()
  if (!trimmed) throw new SessionError('EMPTY_CONTENT', '内容不能为空')
  if (containsSensitive(trimmed)) {
    throw new SessionError(
      'SENSITIVE_CONTENT',
      '内容疑似包含敏感明文（密钥/口令/令牌），已拒绝入库——与插件 memory_store 同一防线',
    )
  }
  return trimmed
}

export class SessionManager {
  private store: JsonlMemoryStore | undefined
  private passphrase: string | undefined
  private openedEncrypted = false

  get activePath(): string | undefined {
    return this.store && !this.isClosed ? this.storeFilePath : undefined
  }
  private storeFilePath: string | undefined

  private get isClosed(): boolean {
    return (this.store as unknown as { closed?: boolean } | undefined)?.closed === true
  }

  /** 当前活动库是否为「已解锁的加密库」（口令在内存中持有） */
  get unlockedEncrypted(): boolean {
    return this.store !== undefined && this.openedEncrypted && this.passphrase !== undefined && this.passphrase !== ''
  }

  isOpen(path?: string): boolean {
    if (this.store === undefined || this.isClosed) return false
    return path === undefined || path === this.storeFilePath
  }

  /**
   * 打开（或切换）记忆库。
   * - 加密库未给口令 → NEEDS_PASSPHRASE（渲染层弹口令框后重试）
   * - 口令错误/库被篡改 → WRONG_PASSPHRASE
   * - 明文库带口令打开 = 启用加密（store 原位迁移，深回放历史保留）
   */
  async open(filePath: string, opts?: { passphrase?: string }): Promise<{ encrypted: boolean }> {
    await this.close()
    const probe = await probeLibrary(filePath)
    const passphrase = opts?.passphrase && opts.passphrase !== '' ? opts.passphrase : undefined
    if (probe.encrypted && passphrase === undefined) {
      throw new SessionError('NEEDS_PASSPHRASE', `该库已加密，需要口令：${filePath}`)
    }
    let store: JsonlMemoryStore
    try {
      store = await JsonlMemoryStore.open(filePath, undefined, passphrase !== undefined ? { passphrase } : undefined)
    } catch (err) {
      if (err instanceof MemoryHubError && err.code === ErrorCodes.STORE_READ_FAILED) {
        const msg = errorMessage(err)
        if (msg.includes('requires a passphrase')) {
          throw new SessionError('NEEDS_PASSPHRASE', `该库已加密，需要口令：${filePath}`)
        }
        if (passphrase !== undefined && probe.encrypted) {
          throw new SessionError('WRONG_PASSPHRASE', '口令错误或库文件被篡改（全部密文行认证失败）')
        }
      }
      throw err
    }
    this.store = store
    this.storeFilePath = filePath
    this.passphrase = passphrase
    this.openedEncrypted = probe.encrypted || passphrase !== undefined
    return { encrypted: this.openedEncrypted }
  }

  /** 锁库：关闭句柄并立即清空口令（重新访问需再次输入口令） */
  async lock(): Promise<void> {
    this.passphrase = undefined
    const s = this.store
    this.store = undefined
    this.storeFilePath = undefined
    this.openedEncrypted = false
    await s?.close().catch(() => {})
  }

  async close(): Promise<void> {
    await this.lock()
  }

  /** 口令轮换 / 启用加密 / 解密回退（next = '' 即解密回退为明文库） */
  async changePassphrase(next: string): Promise<void> {
    const store = this.requireStore()
    await store.changePassphrase(next)
    this.passphrase = next !== '' ? next : undefined
    this.openedEncrypted = next !== ''
  }

  private requireStore(): JsonlMemoryStore {
    if (this.store === undefined || this.isClosed) {
      throw new SessionError('NO_ACTIVE_LIBRARY', '没有打开的记忆库（请先在左侧选择或解锁一个库）')
    }
    return this.store
  }

  /* --------------------------------- 检索 --------------------------------- */

  async list(params: ListParams): Promise<ListResult> {
    const store = this.requireStore()
    const all = await store.list()
    const filtered = all.filter((e) => {
      if (params.kind !== undefined && e.kind !== params.kind) return false
      if (params.source !== undefined && e.source !== params.source) return false
      if (params.tag !== undefined && !e.tags.includes(params.tag)) return false
      if (params.workspace !== undefined && e.workspace !== params.workspace) return false
      return true
    })
    const facets = computeFacets(filtered)
    let items: ListItemHit[]
    const searched = params.query !== undefined && params.query.trim() !== ''
    if (searched) {
      items = recall(filtered, params.query!, {
        ...(params.kind !== undefined ? { kind: params.kind } : {}),
        ...(params.workspace !== undefined ? { workspace: params.workspace } : {}),
        limit: 2000,
        ...(params.explain ? { explain: true } : {}),
      })
    } else {
      const sorted = [...filtered].sort((a, b) => {
        if (params.sort === 'created') return b.createdAt - a.createdAt
        if (params.sort === 'heat') return b.accessCount - a.accessCount || b.updatedAt - a.updatedAt
        return b.updatedAt - a.updatedAt
      })
      items = sorted
    }
    const offset = params.offset ?? 0
    const limit = params.limit ?? 100
    return { total: items.length, offset, items: items.slice(offset, offset + limit), facets, searched }
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    return this.requireStore().get(id)
  }

  /* --------------------------------- 编辑 --------------------------------- */

  async create(params: CreateParams): Promise<MemoryEntry> {
    const store = this.requireStore()
    const content = assertContent(params.content)
    const entry = makeEntry({
      content,
      kind: params.kind ?? 'generic',
      tags: params.tags,
      source: 'explicit',
      workspace: params.workspace,
      maxChars: MAX_ENTRY_CHARS,
    })
    return store.upsert(entry)
  }

  /** 编辑：保留 id / 来源 / 创建时间 / 热度，仅推进内容版本（updatedAt = now） */
  async update(params: UpdateParams): Promise<MemoryEntry> {
    const store = this.requireStore()
    const existing = await store.get(params.id)
    if (existing === undefined) throw new SessionError('NOT_FOUND', `条目不存在：${params.id}`)
    const nextContent = params.content !== undefined ? assertContent(params.content) : existing.content
    const updated: MemoryEntry = {
      ...existing,
      content: safeSlice(nextContent, MAX_ENTRY_CHARS),
      kind: params.kind ?? existing.kind,
      tags: params.tags !== undefined ? cleanTags(params.tags) : existing.tags,
      updatedAt: Date.now(),
    }
    if (params.workspace === null) delete updated.workspace
    else if (params.workspace !== undefined) updated.workspace = params.workspace
    return store.upsert(updated)
  }

  async remove(ids: string[]): Promise<number> {
    return this.requireStore().removeMany(ids)
  }

  /** 取代协议：新条目 supersede:<旧id>，旧条目追加 superseded-by:<新id>（召回降权） */
  async supersede(params: SupersedeParams): Promise<{ newEntry: MemoryEntry; oldEntry: MemoryEntry }> {
    const store = this.requireStore()
    const old = await store.get(params.id)
    if (old === undefined) throw new SessionError('NOT_FOUND', `条目不存在：${params.id}`)
    const content = assertContent(params.content)
    const newTags = cleanTags([
      ...(params.tags ?? old.tags.filter((t) => !t.startsWith(SUPERSEDE_TAG_PREFIX))),
      `${SUPERSEDE_TAG_PREFIX}${old.id}`,
    ])
    const fresh = await store.upsert(
      makeEntry({
        content,
        kind: params.kind ?? old.kind,
        tags: newTags,
        source: 'explicit',
        workspace: old.workspace,
        maxChars: MAX_ENTRY_CHARS,
      }),
    )
    const supersededOld: MemoryEntry = {
      ...old,
      tags: cleanTags([
        ...old.tags.filter((t) => !t.startsWith(SUPERSEDED_BY_TAG_PREFIX)),
        `${SUPERSEDED_BY_TAG_PREFIX}${fresh.id}`,
      ]),
      updatedAt: Date.now(),
    }
    const saved = await store.upsert(supersededOld)
    return { newEntry: fresh, oldEntry: saved }
  }

  /* --------------------------------- 视图 --------------------------------- */

  async status(): Promise<StatusResult> {
    const store = this.requireStore()
    const entries = await store.list()
    const bytes = await stat(this.storeFilePath!).then(
      (s) => s.size,
      () => 0,
    )
    const timeline = (await store.timeline(90)) ?? { firstAt: 0, lastAt: 0, events: 0, truncated: false, buckets: [] }
    const diagnostics = store.diagnostics
    return {
      filePath: this.storeFilePath!,
      encrypted: this.openedEncrypted,
      unlocked: this.unlockedEncrypted,
      stats: summarize(entries, bytes),
      themes: clusterThemes(entries),
      timeline,
      diagnostics: {
        lines: diagnostics.lines,
        skippedCorrupt: diagnostics.corrupt,
        compact: {
          reclaimed: diagnostics.compact?.reclaimed ?? 0,
          ratio: diagnostics.compact?.ratio ?? 0,
          atLineCount: diagnostics.compact?.at ?? 0,
          timestamp: 0,
        },
        revision: store.revision ?? 0,
      },
    }
  }

  /* -------------------------------- 导入导出 -------------------------------- */

  /** JSON 迁移包导出（与插件的 exportAll 同源——跨设备/跨库迁移闭环） */
  async exportJson(): Promise<string> {
    return this.requireStore().exportAll()
  }

  /** 可视化检索页导出（1.5.1 renderMemoryHtml：自包含、确定性、注入安全） */
  async exportHtml(): Promise<string> {
    const store = this.requireStore()
    const entries = await store.list()
    const timeline = await store.timeline(90)
    return renderMemoryHtml({ entries, timeline, generatedAt: Date.now() })
  }

  async importPreview(params: ImportParams): Promise<ImportPreviewResult> {
    const plan = await this.planImport(params)
    return {
      kind: params.kind,
      planned: plan.entries.length,
      sample: plan.entries.slice(0, 20),
      stats: plan.stats,
    }
  }

  async importCommit(params: ImportParams): Promise<ImportCommitResult> {
    const store = this.requireStore()
    const plan = await this.planImport(params)
    const imported = await store.importAll(plan.entries)
    return { imported, stats: { ...plan.stats, imported } }
  }

  private async planImport(
    params: ImportParams,
  ): Promise<{ entries: MemoryEntry[]; stats: ImportPreviewResult['stats'] }> {
    const store = this.requireStore()
    let text: string
    try {
      text = await readFile(params.path, 'utf8')
    } catch (err) {
      throw new SessionError('IO', `无法读取导入文件：${params.path}（${errorMessage(err)}）`)
    }
    if (params.kind === 'json') {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (err) {
        throw new SessionError('IO', `JSON 解析失败（应为 exportAll 导出的数组）：${errorMessage(err)}`)
      }
      if (!Array.isArray(parsed)) throw new SessionError('IO', 'JSON 迁移包应为数组（exportAll 导出格式）')
      const valid: MemoryEntry[] = []
      let invalid = 0
      for (const item of parsed) {
        const e = toMemoryEntry(item)
        if (e === undefined) invalid++
        else valid.push(e)
      }
      const existing = await store.list()
      const existingIds = new Set(existing.map((e) => e.id))
      const fresh = valid.filter((e) => !existingIds.has(e.id))
      const stats = {
        total: parsed.length,
        imported: fresh.length,
        droppedShort: 0,
        droppedSensitive: 0,
        droppedDuplicate: 0,
        corruptLines: 0,
        invalidEntries: invalid,
        existingIds: valid.length - fresh.length,
      }
      return { entries: fresh, stats }
    }
    // markdown / session：与插件启动批量导入同一条 planImport 管道（内容级幂等 + 敏感零豁免）
    const existing = await store.list()
    const options = { mode: params.mode ?? 'balanced', maxChars: MAX_ENTRY_CHARS } as const
    const plan =
      params.kind === 'markdown'
        ? planImport({ documents: [{ label: params.path, text }], options, existing })
        : planImport({ sessions: [{ label: params.path, lines: text.split(/\r?\n/) }], options, existing })
    return { entries: plan.entries, stats: plan.stats }
  }
}

/* --------------------------------- 纯函数 --------------------------------- */

export function computeFacets(entries: readonly MemoryEntry[]): Facets {
  const byKind: Facets['byKind'] = {}
  const bySource: Facets['bySource'] = {}
  const tagMap = new Map<string, number>()
  const wsMap = new Map<string, number>()
  for (const e of entries) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
    bySource[e.source] = (bySource[e.source] ?? 0) + 1
    for (const t of e.tags) tagMap.set(t, (tagMap.get(t) ?? 0) + 1)
    if (e.workspace) wsMap.set(e.workspace, (wsMap.get(e.workspace) ?? 0) + 1)
  }
  return {
    total: entries.length,
    byKind,
    bySource,
    byTag: [...tagMap.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, 50),
    byWorkspace: [...wsMap.entries()]
      .map(([workspace, count]) => ({ workspace, count }))
      .sort((a, b) => b.count - a.count),
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export type { MemoryKind }
