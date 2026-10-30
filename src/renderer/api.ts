/**
 * 渲染进程 API 封装：unwrap {ok,value}|{ok,error} 信封 + 结构化 ApiError
 * （页面层 catch ApiError 按 code 映射中文提示与口令弹窗等交互）
 */
import type {
  ExportResult,
  ImportCommitResult,
  ImportPreviewResult,
  IpcErrorResponse,
  LibrarySummary,
  ListResult,
  MemoryEntry,
  StatusResult,
} from '../shared/protocol'

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly needsPassphrase?: boolean,
    readonly wrongPassphrase?: boolean,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

type Envelope = { ok: true; value: unknown } | { ok: false; error: IpcErrorResponse }

async function unwrap<T>(p: Promise<unknown>): Promise<T> {
  const env = (await p) as Envelope
  if (env && env.ok === true) return env.value as T
  if (env && env.ok === false && env.error) {
    throw new ApiError(env.error.code, env.error.message, env.error.needsPassphrase, env.error.wrongPassphrase)
  }
  throw new ApiError('INTERNAL', `IPC 返回损坏的信封：${JSON.stringify(env).slice(0, 200)}`)
}

interface MhubBridge {
  libList(): Promise<unknown>
  libAdd(p: { filePath: string; passphrase?: string }): Promise<unknown>
  libCreate(p: { filePath: string; passphrase?: string }): Promise<unknown>
  libRemove(p: { id: string }): Promise<unknown>
  libRename(p: { id: string; name: string }): Promise<unknown>
  libActivate(p: { id: string; passphrase?: string }): Promise<unknown>
  libLock(): Promise<unknown>
  libPassphrase(p: { next: string }): Promise<unknown>
  libStatus(): Promise<unknown>
  entryList(p: Record<string, unknown>): Promise<unknown>
  entryGet(p: { id: string }): Promise<unknown>
  entryCreate(p: Record<string, unknown>): Promise<unknown>
  entryUpdate(p: Record<string, unknown>): Promise<unknown>
  entryDelete(p: { ids: string[] }): Promise<unknown>
  entrySupersede(p: Record<string, unknown>): Promise<unknown>
  ioPickOpen(p: { kind?: 'json' | 'markdown' | 'session' }): Promise<unknown>
  ioPickSave(p: { kind?: string; defaultName: string }): Promise<unknown>
  ioExportJson(p: { path: string }): Promise<unknown>
  ioExportHtml(p: { path: string }): Promise<unknown>
  ioImportPreview(p: Record<string, unknown>): Promise<unknown>
  ioImportCommit(p: Record<string, unknown>): Promise<unknown>
}

declare global {
  interface Window {
    mhub: MhubBridge
  }
}

export const api = {
  libList: () => unwrap<LibrarySummary[]>(window.mhub.libList()),
  libAdd: (p: { filePath: string; passphrase?: string }) => unwrap<LibrarySummary[]>(window.mhub.libAdd(p)),
  libCreate: (p: { filePath: string; passphrase?: string }) => unwrap<LibrarySummary[]>(window.mhub.libCreate(p)),
  libRemove: (p: { id: string }) => unwrap<LibrarySummary[]>(window.mhub.libRemove(p)),
  libRename: (p: { id: string; name: string }) => unwrap<LibrarySummary[]>(window.mhub.libRename(p)),
  libActivate: (p: { id: string; passphrase?: string }) => unwrap<LibrarySummary[]>(window.mhub.libActivate(p)),
  libLock: () => unwrap<LibrarySummary[]>(window.mhub.libLock()),
  libPassphrase: (p: { next: string }) => unwrap<{ ok: true }>(window.mhub.libPassphrase(p)),
  libStatus: () => unwrap<StatusResult>(window.mhub.libStatus()),
  entryList: (p: Record<string, unknown>) => unwrap<ListResult>(window.mhub.entryList(p)),
  entryGet: (id: string) => unwrap<MemoryEntry>(window.mhub.entryGet({ id })),
  entryCreate: (p: { content: string; kind?: string; tags?: string[]; workspace?: string }) =>
    unwrap<MemoryEntry>(window.mhub.entryCreate(p)),
  entryUpdate: (p: { id: string; content?: string; kind?: string; tags?: string[]; workspace?: string | null }) =>
    unwrap<MemoryEntry>(window.mhub.entryUpdate(p)),
  entryDelete: (ids: string[]) => unwrap<number>(window.mhub.entryDelete({ ids })),
  entrySupersede: (p: { id: string; content: string; kind?: string; tags?: string[] }) =>
    unwrap<{ newEntry: MemoryEntry; oldEntry: MemoryEntry }>(window.mhub.entrySupersede(p)),
  ioPickOpen: (kind?: 'json' | 'markdown' | 'session') => unwrap<string | null>(window.mhub.ioPickOpen({ kind })),
  ioPickSave: (kind: 'json' | 'html', defaultName: string) =>
    unwrap<string | null>(window.mhub.ioPickSave({ kind, defaultName })),
  ioExportJson: (path: string) => unwrap<ExportResult>(window.mhub.ioExportJson({ path })),
  ioExportHtml: (path: string) => unwrap<ExportResult>(window.mhub.ioExportHtml({ path })),
  ioImportPreview: (p: { kind: 'json' | 'markdown' | 'session'; path: string; mode?: string }) =>
    unwrap<ImportPreviewResult>(window.mhub.ioImportPreview(p)),
  ioImportCommit: (p: { kind: 'json' | 'markdown' | 'session'; path: string; mode?: string }) =>
    unwrap<ImportCommitResult>(window.mhub.ioImportCommit(p)),
}
