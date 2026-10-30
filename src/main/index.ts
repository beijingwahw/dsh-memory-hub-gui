/**
 * Electron 主进程入口：窗口生命周期 + IPC 接线 + 无头冒烟模式
 *
 * 安全基线：contextIsolation 开 / nodeIntegration 关 / sandbox 开，
 * 渲染进程仅经 preload 暴露的白名单通道通信；CSP 由 index.html 声明。
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { createBridge, toIpcError, type BridgeDialogs } from './ipc'
import { LibraryRegistry } from './registry'
import { SessionManager } from './session'
import { Channels } from '../shared/protocol'
import { runSmoke } from './smoke'

const SMOKE = process.argv.includes('--smoke')
const DEV = process.argv.includes('--dev')

// 冒烟模式：隔离 userData（注册表/缓存不污染真实应用状态；可重复运行）
const SMOKE_DIR = join(app.getPath('temp'), `mhub-smoke-${Date.now()}`)
if (SMOKE) {
  app.setPath('userData', join(SMOKE_DIR, 'userData'))
}

let mainWindow: BrowserWindow | undefined
const session = new SessionManager()

const dialogs: BridgeDialogs = SMOKE
  ? {
      // 冒烟模式：原生文件对话框会阻塞无头流程，注入确定性路径替身
      async pickOpen() {
        return join(SMOKE_DIR, 'sample-import.md')
      },
      async pickSave(_kind, defaultName) {
        return join(SMOKE_DIR, defaultName)
      },
    }
  : {
      async pickOpen(kind) {
        const filters = [
          kind === 'json'
            ? { name: 'JSON 迁移包', extensions: ['json'] }
            : kind === 'session'
              ? { name: '会话日志 JSONL', extensions: ['jsonl', 'ndjson'] }
              : { name: 'Markdown 文档', extensions: ['md', 'markdown', 'txt'] },
        ]
        const r = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'], filters })
        return r.canceled || r.filePaths.length === 0 ? undefined : r.filePaths[0]
      },
      async pickSave(kind, defaultName) {
        const filters = [
          kind === 'html'
            ? { name: '自包含 HTML 页面', extensions: ['html'] }
            : { name: 'JSON 迁移包', extensions: ['json'] },
        ]
        const r = await dialog.showSaveDialog(mainWindow!, { defaultPath: defaultName, filters })
        return r.canceled || !r.filePath ? undefined : r.filePath
      },
    }

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    show: !SMOKE,
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    title: 'DSH Memory Hub — 跨平台记忆管理',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 冒烟模式关闭后台节流，保证隐藏窗口正常绘制
      backgroundThrottling: !SMOKE,
    },
  })
  await win.loadFile(join(__dirname, '..', 'renderer', 'index.html'), { hash: SMOKE ? 'smoke' : undefined })
  if (DEV) win.webContents.openDevTools({ mode: 'detach' })
  return win
}

function registerIpc(): void {
  const registryPromise = LibraryRegistry.load(
    join(app.getPath('userData'), 'libraries.json'),
    SMOKE ? { defaultPath: join(SMOKE_DIR, 'default-library.jsonl') } : undefined,
  )
  let bridgePromise: ReturnType<typeof createBridge> | undefined
  const getBridge = async () => {
    if (bridgePromise === undefined) {
      bridgePromise = createBridge({ registry: await registryPromise, session, dialogs })
    }
    return bridgePromise
  }
  for (const channel of Object.values(Channels)) {
    ipcMain.handle(channel, async (_event, payload) => {
      const t0 = Date.now()
      try {
        const bridge = await getBridge()
        const handler = bridge.get(channel)
        if (handler === undefined) throw new Error(`no handler for channel ${channel}`)
        const value = await handler(payload)
        if (Date.now() - t0 > 300) console.log(`[ipc-slow] ${channel} ${Date.now() - t0}ms`)
        return { ok: true as const, value }
      } catch (err) {
        console.log(`[ipc-err] ${channel} ${Date.now() - t0}ms ${String((err as Error)?.message ?? err).slice(0, 120)}`)
        return { ok: false as const, error: toIpcError(err) }
      }
    })
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    registerIpc()
    mainWindow = await createWindow()
    if (SMOKE) {
      const code = await runSmoke(mainWindow, SMOKE_DIR).catch((err) => {
        console.error('[smoke] failed:', err)
        return 1
      })
      await session.close().catch(() => {})
      app.exit(code)
      return
    }
    winAllClosedQuit()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && !SMOKE) {
        void createWindow().then((w) => (mainWindow = w))
      }
    })
  })
}

function winAllClosedQuit(): void {
  app.on('window-all-closed', () => {
    app.quit()
  })
}

app.on('before-quit', () => {
  void session.close()
})
