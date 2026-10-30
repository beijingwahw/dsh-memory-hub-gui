/**
 * IPC 桥：协议通道 → 注册表/会话门面 的纯装配层
 *
 * - 本模块零 Electron 导入（对话框/写文件经依赖注入），vitest 可整体装配测试；
 * - 错误统一序列化为 IpcErrorResponse（渲染层按 code 映射中文提示并驱动口令框）；
 * - 每个通道入口先过 Validators 运行期校验，畸形载荷显式失败。
 */
import { mkdir, writeFile as fsWriteFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { LibraryRegistry, RegistryError } from './registry'
import { SessionError, SessionManager, probeLibrary } from './session'
import { Channels, ErrorKind, ValidationError, Validators } from '../shared/protocol'
import type { ExportResult, IpcErrorResponse, LibrarySummary, StatusResult } from '../shared/protocol'

export interface BridgeDialogs {
  /** 选择导入源文件（json/markdown/session 过滤器）；取消返回 undefined */
  pickOpen(kind?: 'json' | 'markdown' | 'session'): Promise<string | undefined>
  /** 选择导出目标（保存框）；取消返回 undefined */
  pickSave(kind: 'json' | 'html', defaultName: string): Promise<string | undefined>
}

export interface BridgeDeps {
  registry: LibraryRegistry
  session: SessionManager
  dialogs: BridgeDialogs
  /** 注入以便测试替身 */
  writeFile?: (path: string, data: string) => Promise<void>
}

type Handler = (payload: unknown) => Promise<unknown>

export function toIpcError(err: unknown): IpcErrorResponse {
  if (err instanceof SessionError) {
    return {
      code: err.kind,
      message: err.message,
      needsPassphrase: err.kind === ErrorKind.needsPassphrase,
      wrongPassphrase: err.kind === ErrorKind.wrongPassphrase,
    }
  }
  if (err instanceof RegistryError) return { code: err.code, message: err.message }
  if (err instanceof ValidationError) return { code: ErrorKind.invalidPayload, message: err.message }
  if (err instanceof Error) {
    if (err.name === 'MemoryHubError') return { code: ErrorKind.internal, message: err.message }
    if (
      'code' in err &&
      typeof (err as { code?: unknown }).code === 'string' &&
      (err as { code: string }).code.startsWith('E')
    ) {
      return { code: ErrorKind.io, message: `${(err as { code: string }).code}: ${err.message}` }
    }
    return { code: ErrorKind.internal, message: err.message }
  }
  return { code: ErrorKind.internal, message: String(err) }
}

export function createBridge(deps: BridgeDeps): Map<string, Handler> {
  const { registry, session, dialogs } = deps
  const writeFile =
    deps.writeFile ??
    (async (path, data) => {
      await mkdir(dirname(path), { recursive: true })
      await fsWriteFile(path, data, 'utf8')
    })

  /** 侧栏列表 = 注册记录 + 磁盘探测 + 会话打开态 */
  async function summarize(): Promise<LibrarySummary[]> {
    const activePath = session.activePath
    const out: LibrarySummary[] = []
    for (const record of registry.list()) {
      const probe = await probeLibrary(record.filePath).catch(() => ({ exists: false, encrypted: false, bytes: 0 }))
      const open = session.isOpen(record.filePath)
        ? {
            entryCount: -1,
            encryptedUnlocked: session.unlockedEncrypted,
          }
        : undefined
      // 条目计数：仅活动库即时可取（避免侧栏整读每个库文件）
      if (open && open.entryCount === -1) {
        try {
          open.entryCount = (await session.list({ limit: 1 })).total
        } catch {
          open.entryCount = 0
        }
      }
      out.push({ ...record, ...probe, open, active: activePath === record.filePath })
    }
    return out
  }

  async function withOpen(filePath: string, passphrase: string | undefined): Promise<void> {
    await session.open(filePath, passphrase !== undefined ? { passphrase } : undefined)
    const record = registry.getByPath(filePath)
    if (record) {
      registry.touch(record.id)
      await registry.save().catch(() => {})
    }
  }

  const bridge = new Map<string, Handler>([
    [Channels.libList, async () => summarize()],

    [
      Channels.libAdd,
      async (payload) => {
        const { filePath, passphrase } = Validators.libAdd(payload)
        const record = await registry.add(filePath)
        try {
          await withOpen(record.filePath, passphrase)
        } catch (err) {
          // 打开失败（如缺口令）保留注册项——用户可稍后解锁
          if (!(err instanceof SessionError) || err.kind !== ErrorKind.needsPassphrase) throw err
        }
        return summarize()
      },
    ],

    [
      Channels.libCreate,
      async (payload) => {
        const { filePath, passphrase } = Validators.libCreate(payload)
        const record = await registry.create(filePath)
        await withOpen(record.filePath, passphrase)
        return summarize()
      },
    ],

    [
      Channels.libRemove,
      async (payload) => {
        const { id } = Validators.libRemove(payload)
        const record = registry.get(id)
        if (record && session.isOpen(record.filePath)) await session.close()
        await registry.remove(id)
        return summarize()
      },
    ],

    [
      Channels.libRename,
      async (payload) => {
        const { id, name } = Validators.libRename(payload)
        await registry.rename(id, name)
        return summarize()
      },
    ],

    [
      Channels.libActivate,
      async (payload) => {
        const { id, passphrase } = Validators.libActivate(payload)
        const record = registry.get(id)
        if (record === undefined) throw new RegistryError('NOT_FOUND', `库不存在：${id}`)
        await withOpen(record.filePath, passphrase)
        return summarize()
      },
    ],

    [
      Channels.libLock,
      async () => {
        await session.lock()
        return summarize()
      },
    ],

    [Channels.libStatus, async () => status()],

    [
      Channels.entryList,
      async (payload) => {
        const params = Validators.entryList(payload)
        return session.list({ ...params, query: params.query?.trim() || undefined })
      },
    ],

    [
      Channels.entryGet,
      async (payload) => {
        const { id } = Validators.entryGet(payload)
        const entry = await session.get(id)
        if (entry === undefined) throw new SessionError('NOT_FOUND', `条目不存在：${id}`)
        return entry
      },
    ],

    [Channels.entryCreate, async (payload) => session.create(Validators.entryCreate(payload))],

    [Channels.entryUpdate, async (payload) => session.update(Validators.entryUpdate(payload))],

    [Channels.entryDelete, async (payload) => session.remove(Validators.entryDelete(payload).ids)],

    [Channels.entrySupersede, async (payload) => session.supersede(Validators.entrySupersede(payload))],

    [
      Channels.ioPickOpen,
      async (payload) => {
        const { kind } = Validators.ioPickOpen(payload)
        return (await dialogs.pickOpen(kind)) ?? null
      },
    ],

    [
      Channels.ioPickSave,
      async (payload) => {
        const { kind, defaultName } = Validators.ioPickSave(payload)
        return (await dialogs.pickSave(kind, defaultName)) ?? null
      },
    ],

    [
      Channels.ioExportJson,
      async (payload) => {
        const { path } = Validators.ioExportJson(payload)
        const json = await session.exportJson()
        const count = (JSON.parse(json) as unknown[]).length
        await writeFile(path, json)
        return { path, bytes: Buffer.byteLength(json, 'utf8'), count } satisfies ExportResult
      },
    ],

    [
      Channels.ioExportHtml,
      async (payload) => {
        const { path } = Validators.ioExportHtml(payload)
        const html = await session.exportHtml()
        await writeFile(path, html)
        return { path, bytes: Buffer.byteLength(html, 'utf8') } satisfies ExportResult
      },
    ],

    [
      Channels.ioImportPreview,
      async (payload) => {
        const params = Validators.ioImportPreview(payload)
        return session.importPreview(params)
      },
    ],

    [
      Channels.ioImportCommit,
      async (payload) => {
        const params = Validators.ioImportCommit(payload)
        return session.importCommit(params)
      },
    ],
  ])

  async function status(): Promise<StatusResult> {
    return session.status()
  }

  bridge.set(Channels.libPassphrase, async (payload) => {
    const { next } = Validators.libPassphrase(payload)
    await session.changePassphrase(next)
    return { ok: true as const }
  })

  return bridge
}
