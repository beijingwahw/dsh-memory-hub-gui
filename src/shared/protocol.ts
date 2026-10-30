/**
 * dsh-memory-hub-gui IPC 契约（主进程 ⇄ 渲染进程唯一通道）
 *
 * - 渲染进程零 Node 能力（contextIsolation + sandbox），全部存储操作经本契约的
 *   invoke 通道进入主进程执行；
 * - 主进程侧对每个入参做运行期校验（validate*），畸形载荷显式失败而非静默吞掉；
 * - 领域语义全部来自 dsh-memory-hub/core（./core 子路径导出），GUI 不复制实现。
 */

/* ---------------------------------- 通道 ---------------------------------- */

export const Channels = {
  libList: 'lib:list',
  libAdd: 'lib:add',
  libCreate: 'lib:create',
  libRemove: 'lib:remove',
  libRename: 'lib:rename',
  libActivate: 'lib:activate',
  libLock: 'lib:lock',
  libProbe: 'lib:probe',
  libPassphrase: 'lib:passphrase',
  libStatus: 'lib:status',
  entryList: 'entry:list',
  entryGet: 'entry:get',
  entryCreate: 'entry:create',
  entryUpdate: 'entry:update',
  entryDelete: 'entry:delete',
  entrySupersede: 'entry:supersede',
  ioPickOpen: 'io:pick-open',
  ioPickSave: 'io:pick-save',
  ioExportJson: 'io:export-json',
  ioExportHtml: 'io:export-html',
  ioImportPreview: 'io:import-preview',
  ioImportCommit: 'io:import-commit',
} as const

export type Channel = (typeof Channels)[keyof typeof Channels]

/* --------------------------------- 数据形状 --------------------------------- */

import type {
  MemoryEntry,
  MemoryHit,
  MemoryKind,
  MemorySource,
  MemoryStats,
  MemoryTimeline,
  ThemeCluster,
} from 'dsh-memory-hub/core'

export type { MemoryEntry, MemoryHit, MemoryKind, MemorySource, MemoryStats, MemoryTimeline, ThemeCluster }

/** 注册表中的库记录（持久化于 userData/libraries.json） */
export interface LibraryRecord {
  id: string
  name: string
  filePath: string
  /** 插件默认库（~/.dsh/memory-hub/memories.jsonl），不可移除 */
  isDefault?: boolean
  addedAt: number
  lastOpenedAt?: number
}

/** 侧栏库条目 = 注册记录 + 磁盘探测（加密形态 / 体量 / 打开态） */
export interface LibrarySummary extends LibraryRecord {
  exists: boolean
  encrypted: boolean
  bytes: number
  /** 当前会话已打开（含条目计数）；未打开为 undefined（加密未开库显示 🔒） */
  open?: { entryCount: number; encryptedUnlocked: boolean }
  active: boolean
}

export interface ListParams {
  query?: string
  kind?: MemoryKind
  source?: MemorySource
  tag?: string
  workspace?: string
  /** 排序键（query 存在时强制按评分） */
  sort?: 'updated' | 'created' | 'heat'
  limit?: number
  offset?: number
  /** 附带召回溯源（why）——仅 query 检索时有意义 */
  explain?: boolean
}

export interface Facets {
  total: number
  byKind: Partial<Record<MemoryKind, number>>
  bySource: Partial<Record<MemorySource, number>>
  byTag: Array<{ tag: string; count: number }>
  byWorkspace: Array<{ workspace: string; count: number }>
}

/** 列表条目：检索时带 score/why；浏览态为普通条目（score 缺席） */
export interface ListItemHit extends MemoryEntry {
  score?: number
  why?: MemoryHit['why']
}

export interface ListResult {
  total: number
  offset: number
  items: ListItemHit[]
  facets: Facets
  searched: boolean
}

export interface CreateParams {
  content: string
  kind?: MemoryKind
  tags?: string[]
  workspace?: string
}

export interface UpdateParams {
  id: string
  content?: string
  kind?: MemoryKind
  tags?: string[]
  workspace?: string | null
}

export interface SupersedeParams {
  id: string
  content: string
  kind?: MemoryKind
  tags?: string[]
}

export interface StatusResult {
  filePath: string
  encrypted: boolean
  unlocked: boolean
  stats: MemoryStats
  themes: ThemeCluster[]
  timeline: MemoryTimeline
  diagnostics: {
    lines: number
    skippedCorrupt: number
    compact: { reclaimed: number; ratio: number; atLineCount: number; timestamp: number }
    revision: number
  }
}

export type ImportKind = 'json' | 'markdown' | 'session'

export interface ImportParams {
  kind: ImportKind
  /** 绝对路径（主进程侧读取，渲染进程不接触文件系统） */
  path: string
  /** markdown / session 生效：conservative | balanced | aggressive */
  mode?: 'conservative' | 'balanced' | 'aggressive'
}

export interface ImportPreviewResult {
  kind: ImportKind
  /** 计划入库条数（json：校验通过且 id 不与库内冲突的新条目） */
  planned: number
  sample: MemoryEntry[]
  stats: {
    total: number
    imported: number
    droppedShort: number
    droppedSensitive: number
    droppedDuplicate: number
    corruptLines: number
    /** json 专用：结构非法行数 / id 已存在跳过数 */
    invalidEntries?: number
    existingIds?: number
  }
}

export interface ImportCommitResult {
  imported: number
  stats: ImportPreviewResult['stats']
}

export interface ExportResult {
  path: string
  bytes: number
  count?: number
}

/* ------------------------------ 错误形状（结构化） ------------------------------ */

/** 主进程 → 渲染进程的结构化错误（渲染层按 code 映射中文提示） */
export interface IpcErrorResponse {
  code: string
  message: string
  /** 打开加密库缺口令时的专用码（渲染层弹口令框重试） */
  needsPassphrase?: boolean
  wrongPassphrase?: boolean
}

export const ErrorKind = {
  needsPassphrase: 'NEEDS_PASSPHRASE',
  wrongPassphrase: 'WRONG_PASSPHRASE',
  emptyContent: 'EMPTY_CONTENT',
  sensitiveContent: 'SENSITIVE_CONTENT',
  notFound: 'NOT_FOUND',
  noLibrary: 'NO_ACTIVE_LIBRARY',
  libraryLocked: 'LIBRARY_LOCKED',
  duplicateLibrary: 'DUPLICATE_LIBRARY',
  invalidPayload: 'INVALID_PAYLOAD',
  io: 'IO_ERROR',
  internal: 'INTERNAL',
} as const

/* -------------------------------- 入参校验 -------------------------------- */

const KINDS: readonly MemoryKind[] = ['decision', 'fact', 'preference', 'instruction', 'generic']
const SOURCES: readonly MemorySource[] = ['auto', 'explicit']
const IMPORT_KINDS: readonly ImportKind[] = ['json', 'markdown', 'session']
const MODES: readonly ('conservative' | 'balanced' | 'aggressive')[] = ['conservative', 'balanced', 'aggressive']

export class ValidationError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'ValidationError'
  }
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${where}: expected object`)
  }
  return value as Record<string, unknown>
}

function optString(value: unknown, where: string, max = 100_000): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ValidationError(`${where}: expected string`)
  if (value.length > max) throw new ValidationError(`${where}: too long (>${max})`)
  return value
}

function reqString(value: unknown, where: string, max = 100_000): string {
  const s = optString(value, where, max)
  if (s === undefined) throw new ValidationError(`${where}: required string`)
  return s
}

function optEnum<T extends string>(value: unknown, allowed: readonly T[], where: string): T | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(`${where}: expected one of ${allowed.join(' | ')}`)
  }
  return value as T
}

function optStringArray(value: unknown, where: string, maxItems = 64): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new ValidationError(`${where}: expected array`)
  if (value.length > maxItems) throw new ValidationError(`${where}: too many items (>${maxItems})`)
  return value.map((v, i) => reqString(v, `${where}[${i}]`, 200))
}

export const Validators = {
  libList: (_v: unknown) => asObject(_v ?? {}, 'libList'),
  libAdd: (v: unknown) => {
    const o = asObject(v, 'libAdd')
    return {
      filePath: reqString(o['filePath'], 'libAdd.filePath', 1024),
      passphrase: optString(o['passphrase'], 'libAdd.passphrase', 1024),
    }
  },
  libCreate: (v: unknown) => {
    const o = asObject(v, 'libCreate')
    return {
      filePath: reqString(o['filePath'], 'libCreate.filePath', 1024),
      passphrase: optString(o['passphrase'], 'libCreate.passphrase', 1024),
    }
  },
  libRemove: (v: unknown) => {
    const o = asObject(v, 'libRemove')
    return { id: reqString(o['id'], 'libRemove.id', 128) }
  },
  libRename: (v: unknown) => {
    const o = asObject(v, 'libRename')
    return { id: reqString(o['id'], 'libRename.id', 128), name: reqString(o['name'], 'libRename.name', 120) }
  },
  libActivate: (v: unknown) => {
    const o = asObject(v, 'libActivate')
    return {
      id: reqString(o['id'], 'libActivate.id', 128),
      passphrase: optString(o['passphrase'], 'libActivate.passphrase', 1024),
    }
  },
  libLock: (_v: unknown) => asObject(_v ?? {}, 'libLock'),
  libPassphrase: (v: unknown) => {
    const o = asObject(v, 'libPassphrase')
    const next = optString(o['next'], 'libPassphrase.next', 1024)
    return { next: next === undefined ? '' : next }
  },
  libStatus: (_v: unknown) => asObject(_v ?? {}, 'libStatus'),
  entryList: (v: unknown) => {
    const o = asObject(v ?? {}, 'entryList')
    const limit = o['limit'] === undefined ? undefined : Number(o['limit'])
    const offset = o['offset'] === undefined ? undefined : Number(o['offset'])
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 2000)) {
      throw new ValidationError('entryList.limit: expected integer 1..2000')
    }
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000)) {
      throw new ValidationError('entryList.offset: expected integer >= 0')
    }
    const workspace = optString(o['workspace'], 'entryList.workspace', 200)
    return {
      query: optString(o['query'], 'entryList.query', 2000),
      kind: optEnum(o['kind'], KINDS, 'entryList.kind'),
      source: optEnum(o['source'], SOURCES, 'entryList.source'),
      tag: optString(o['tag'], 'entryList.tag', 200),
      workspace,
      sort: optEnum(o['sort'], ['updated', 'created', 'heat'] as const, 'entryList.sort'),
      limit,
      offset,
      explain: o['explain'] === true,
    }
  },
  entryGet: (v: unknown) => {
    const o = asObject(v, 'entryGet')
    return { id: reqString(o['id'], 'entryGet.id', 128) }
  },
  entryCreate: (v: unknown) => {
    const o = asObject(v, 'entryCreate')
    const ws = optString(o['workspace'], 'entryCreate.workspace', 200)
    return {
      content: reqString(o['content'], 'entryCreate.content', 20_000),
      kind: optEnum(o['kind'], KINDS, 'entryCreate.kind'),
      tags: optStringArray(o['tags'], 'entryCreate.tags'),
      workspace: ws === '' ? undefined : ws,
    }
  },
  entryUpdate: (v: unknown) => {
    const o = asObject(v, 'entryUpdate')
    const ws = optString(o['workspace'], 'entryUpdate.workspace', 200)
    return {
      id: reqString(o['id'], 'entryUpdate.id', 128),
      content: optString(o['content'], 'entryUpdate.content', 20_000),
      kind: optEnum(o['kind'], KINDS, 'entryUpdate.kind'),
      tags: optStringArray(o['tags'], 'entryUpdate.tags'),
      // null = 显式清除工作区；undefined = 不改
      workspace: o['workspace'] === null ? null : ws === undefined ? undefined : ws,
    }
  },
  entryDelete: (v: unknown) => {
    const o = asObject(v, 'entryDelete')
    const ids = optStringArray(o['ids'], 'entryDelete.ids', 500)
    if (ids === undefined || ids.length === 0) throw new ValidationError('entryDelete.ids: required non-empty array')
    return { ids }
  },
  entrySupersede: (v: unknown) => {
    const o = asObject(v, 'entrySupersede')
    return {
      id: reqString(o['id'], 'entrySupersede.id', 128),
      content: reqString(o['content'], 'entrySupersede.content', 20_000),
      kind: optEnum(o['kind'], KINDS, 'entrySupersede.kind'),
      tags: optStringArray(o['tags'], 'entrySupersede.tags'),
    }
  },
  ioPickOpen: (v: unknown) => {
    const o = asObject(v ?? {}, 'ioPickOpen')
    return { kind: optEnum(o['kind'], IMPORT_KINDS, 'ioPickOpen.kind') }
  },
  ioPickSave: (v: unknown) => {
    const o = asObject(v ?? {}, 'ioPickSave')
    return {
      kind: optEnum(o['kind'], ['json', 'html'] as const, 'ioPickSave.kind') ?? 'json',
      defaultName: reqString(o['defaultName'], 'ioPickSave.defaultName', 200),
    }
  },
  ioExportJson: (v: unknown) => {
    const o = asObject(v, 'ioExportJson')
    return { path: reqString(o['path'], 'ioExportJson.path', 1024) }
  },
  ioExportHtml: (v: unknown) => {
    const o = asObject(v, 'ioExportHtml')
    return { path: reqString(o['path'], 'ioExportHtml.path', 1024) }
  },
  ioImportPreview: (v: unknown) => {
    const o = asObject(v, 'ioImportPreview')
    return {
      kind: optEnum(o['kind'], IMPORT_KINDS, 'ioImportPreview.kind') ?? 'markdown',
      path: reqString(o['path'], 'ioImportPreview.path', 1024),
      mode: optEnum(o['mode'], MODES, 'ioImportPreview.mode') ?? 'balanced',
    }
  },
  ioImportCommit: (v: unknown) => {
    const o = asObject(v, 'ioImportCommit')
    return {
      kind: optEnum(o['kind'], IMPORT_KINDS, 'ioImportCommit.kind') ?? 'markdown',
      path: reqString(o['path'], 'ioImportCommit.path', 1024),
      mode: optEnum(o['mode'], MODES, 'ioImportCommit.mode') ?? 'balanced',
    }
  },
}

export type Validated<T> = T extends (v: unknown) => infer R ? R : never
