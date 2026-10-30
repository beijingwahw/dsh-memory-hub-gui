/**
 * preload：渲染进程唯一桥（contextBridge 白名单通道）
 *
 * 不暴露 ipcRenderer 本体、不暴露任意 channel 调用——每个业务动作一个方法，
 * 载荷在主进程侧统一校验。sandbox 兼容（CJS 包，无 Node API 使用）。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { Channels } from '../shared/protocol'

const SMOKE_LOG = location.hash.includes('smoke')
const call = (channel: string, payload?: unknown): Promise<unknown> => {
  const t0 = Date.now()
  const p = ipcRenderer.invoke(channel, payload ?? {})
  if (SMOKE_LOG) {
    p.then(
      (v: unknown) => {
        const env = v as { value?: { total?: number; id?: string } }
        const extra =
          env?.value?.total !== undefined
            ? ` total=${env.value.total}`
            : env?.value?.id !== undefined
              ? ` id=${env.value.id.slice(0, 8)}`
              : ''
        console.log(`[pre] ${channel} ok ${Date.now() - t0}ms${extra}`)
      },
      (e) => console.log(`[pre] ${channel} ERR ${Date.now() - t0}ms ${String(e).slice(0, 80)}`),
    )
  }
  return p
}

contextBridge.exposeInMainWorld('mhub', {
  libList: () => call(Channels.libList),
  libAdd: (p: { filePath: string; passphrase?: string }) => call(Channels.libAdd, p),
  libCreate: (p: { filePath: string; passphrase?: string }) => call(Channels.libCreate, p),
  libRemove: (p: { id: string }) => call(Channels.libRemove, p),
  libRename: (p: { id: string; name: string }) => call(Channels.libRename, p),
  libActivate: (p: { id: string; passphrase?: string }) => call(Channels.libActivate, p),
  libLock: () => call(Channels.libLock),
  libPassphrase: (p: { next: string }) => call(Channels.libPassphrase, p),
  libStatus: () => call(Channels.libStatus),
  entryList: (p: Record<string, unknown>) => call(Channels.entryList, p),
  entryGet: (p: { id: string }) => call(Channels.entryGet, p),
  entryCreate: (p: Record<string, unknown>) => call(Channels.entryCreate, p),
  entryUpdate: (p: Record<string, unknown>) => call(Channels.entryUpdate, p),
  entryDelete: (p: { ids: string[] }) => call(Channels.entryDelete, p),
  entrySupersede: (p: Record<string, unknown>) => call(Channels.entrySupersede, p),
  ioPickOpen: (p: { kind?: 'json' | 'markdown' | 'session' }) => call(Channels.ioPickOpen, p),
  ioPickSave: (p: { kind?: string; defaultName: string }) => call(Channels.ioPickSave, p),
  ioExportJson: (p: { path: string }) => call(Channels.ioExportJson, p),
  ioExportHtml: (p: { path: string }) => call(Channels.ioExportHtml, p),
  ioImportPreview: (p: Record<string, unknown>) => call(Channels.ioImportPreview, p),
  ioImportCommit: (p: Record<string, unknown>) => call(Channels.ioImportCommit, p),
})
