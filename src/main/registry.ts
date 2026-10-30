/**
 * 多库注册表（持久化于应用 userData/libraries.json）
 *
 * - 「多库管理」的数据面：一组库记录（绝对路径 + 展示名 + 打开时间），
 *   与磁盘上的 .jsonl 记忆库一一对应；
 * - 插件默认库（~/.dsh/memory-hub/memories.jsonl）首次加载自动注入且不可移除
 *   ——与 dsh 插件共享同一份记忆；
 * - 写入原子性：tmp + rename，损坏时回退空注册表并保留 .bak 留证；
 * - 纯 Node 模块（零 Electron 依赖），可在 vitest 中直接实例化。
 */
import { mkdir, readFile, rename, writeFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 默认库路径：与 dsh-memory-hub 插件缺省存储一致（README「共享同一份记忆」） */
export function defaultLibraryPath(): string {
  return join(homedir(), '.dsh', 'memory-hub', 'memories.jsonl')
}

export class RegistryError extends Error {
  constructor(
    readonly code:
      'DUPLICATE_LIBRARY' | 'LIBRARY_EXISTS' | 'NOT_FOUND' | 'DEFAULT_IMMUTABLE' | 'INVALID_NAME' | 'INVALID_PATH',
    message: string,
  ) {
    super(message)
    this.name = 'RegistryError'
  }
}

export interface LibraryRecord {
  id: string
  name: string
  filePath: string
  isDefault?: boolean
  addedAt: number
  lastOpenedAt?: number
}

/** 路径归一化：分隔符统一 + 尾分隔符剥离，保证跨平台同库去重键稳定 */
export function normalizePath(p: string): string {
  let n = resolve(p)
  if (n.length > 1 && n.endsWith(sep)) n = n.slice(0, -1)
  if (sep === '\\') n = n.replace(/\//g, '\\')
  return n
}

interface RegistryFile {
  version: 1
  libraries: LibraryRecord[]
}

export class LibraryRegistry {
  private records: LibraryRecord[] = []
  private readonly defaultPath: string

  private constructor(
    readonly jsonPath: string,
    defaultPath: string,
  ) {
    this.defaultPath = defaultPath
  }

  static async load(jsonPath: string, opts?: { defaultPath?: string }): Promise<LibraryRegistry> {
    const reg = new LibraryRegistry(jsonPath, opts?.defaultPath ?? defaultLibraryPath())
    let raw: string | undefined
    try {
      raw = await readFile(jsonPath, 'utf8')
    } catch {
      // 首次运行（或文件缺失）：空注册表起步
    }
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as RegistryFile
        if (parsed && Array.isArray(parsed.libraries)) {
          // 宽容读取：逐条校验，坏行丢弃（注册表不是记忆数据，无需留证语义）
          reg.records = parsed.libraries.filter(
            (r): r is LibraryRecord =>
              typeof r?.id === 'string' &&
              typeof r?.name === 'string' &&
              typeof r?.filePath === 'string' &&
              typeof r?.addedAt === 'number',
          )
        }
      } catch {
        // 损坏：留证后重置
        try {
          await rm(`${jsonPath}.bak`, { force: true })
          await rename(jsonPath, `${jsonPath}.bak`)
        } catch {
          /* 留证尽力而为 */
        }
      }
    }
    // 默认库注入：始终排在首位且不可移除
    const normalizedDefault = normalizePath(reg.defaultPath)
    if (!reg.records.some((r) => normalizePath(r.filePath) === normalizedDefault)) {
      reg.records.unshift({
        id: randomUUID(),
        name: '默认库',
        filePath: reg.defaultPath,
        isDefault: true,
        addedAt: Date.now(),
      })
    } else {
      const def = reg.records.find((r) => normalizePath(r.filePath) === normalizedDefault)!
      def.isDefault = true
      def.name = def.name || '默认库'
    }
    return reg
  }

  list(): LibraryRecord[] {
    return [...this.records]
  }

  get(id: string): LibraryRecord | undefined {
    return this.records.find((r) => r.id === id)
  }

  getByPath(filePath: string): LibraryRecord | undefined {
    const n = normalizePath(filePath)
    return this.records.find((r) => normalizePath(r.filePath) === n)
  }

  /** 注册一个既有库文件（重复路径显式拒绝；不校验文件内容——打开时才探测） */
  async add(filePath: string, name?: string): Promise<LibraryRecord> {
    const normalized = normalizePath(filePath)
    if (!normalized.toLowerCase().endsWith('.jsonl')) {
      throw new RegistryError('INVALID_PATH', `记忆库文件应以 .jsonl 结尾：${filePath}`)
    }
    if (this.getByPath(normalized)) {
      throw new RegistryError('DUPLICATE_LIBRARY', `该库已在列表中：${normalized}`)
    }
    const record: LibraryRecord = {
      id: randomUUID(),
      name: (name ?? '').trim() || defaultName(normalized),
      filePath: normalized,
      addedAt: Date.now(),
    }
    this.records.push(record)
    await this.save()
    return record
  }

  /** 新建空库：建目录 + 注册；文件已存在（且非空）时拒绝，防误覆盖既有记忆 */
  async create(filePath: string, name?: string): Promise<LibraryRecord> {
    const normalized = normalizePath(filePath)
    if (!normalized.toLowerCase().endsWith('.jsonl')) {
      throw new RegistryError('INVALID_PATH', `新库文件应以 .jsonl 结尾：${filePath}`)
    }
    if (this.getByPath(normalized)) {
      throw new RegistryError('DUPLICATE_LIBRARY', `该库已在列表中：${normalized}`)
    }
    const exists = await stat(normalized).then(
      () => true,
      () => false,
    )
    if (exists) {
      const raw = await readFile(normalized, 'utf8').catch(() => '')
      if (raw.trim().length > 0) {
        throw new RegistryError('LIBRARY_EXISTS', `目标文件已存在且非空，拒绝新建（防覆盖）：${normalized}`)
      }
    }
    await mkdir(dirname(normalized), { recursive: true })
    const record: LibraryRecord = {
      id: randomUUID(),
      name: (name ?? '').trim() || defaultName(normalized),
      filePath: normalized,
      addedAt: Date.now(),
    }
    this.records.push(record)
    await this.save()
    return record
  }

  /** 移出列表（不删除磁盘文件）；默认库不可移除 */
  async remove(id: string): Promise<void> {
    const record = this.get(id)
    if (!record) throw new RegistryError('NOT_FOUND', `库不存在：${id}`)
    if (record.isDefault) throw new RegistryError('DEFAULT_IMMUTABLE', '默认库不可从列表移除')
    this.records = this.records.filter((r) => r.id !== id)
    await this.save()
  }

  async rename(id: string, name: string): Promise<LibraryRecord> {
    const record = this.get(id)
    if (!record) throw new RegistryError('NOT_FOUND', `库不存在：${id}`)
    const clean = name.trim()
    if (!clean) throw new RegistryError('INVALID_NAME', '库名不能为空')
    record.name = clean
    await this.save()
    return record
  }

  touch(id: string): void {
    const record = this.get(id)
    if (record) record.lastOpenedAt = Date.now()
  }

  async save(): Promise<void> {
    const file: RegistryFile = { version: 1, libraries: this.records }
    const dir = dirname(this.jsonPath)
    await mkdir(dir, { recursive: true })
    const tmp = join(tmpdir(), `mhub-registry-${randomUUID().slice(0, 8)}.json`)
    await writeFile(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8')
    try {
      await rename(tmp, this.jsonPath)
    } catch (err) {
      // Windows 上 rename 覆盖已存在目标偶尔失败（句柄占用）：退化为直接写
      await rm(tmp, { force: true })
      await writeFile(this.jsonPath, JSON.stringify(file, null, 2) + '\n', 'utf8')
      void err
    }
  }
}

function defaultName(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? 'memory'
  return base.replace(/\.jsonl$/i, '') || '记忆库'
}
