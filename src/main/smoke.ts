/**
 * 主进程冒烟编排：准备样本数据 → 逐步驱动渲染进程 → 每步截图留证 → 汇总退出码
 *
 * 全程隐藏窗口（show:false + 关闭后台节流）；截图过小时回退为短暂显示后重拍。
 */
import type { BrowserWindow } from 'electron'
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const SAMPLE_MARKDOWN = `# 项目记忆导入样例

## 构建与测试

dsh-memory-hub 的构建命令是 pnpm build，完整质量门禁入口是 npm run check，
包含类型检查、lint、prettier 与全量 vitest 套件。

## 架构决策

存储层采用 append-only JSONL + tombstone 软删除 + 按需 compact，
任何时刻的库状态都可以由日志单遍回放重建（情景回放）。

## 用户偏好

界面文案一律使用中文；代码注释解释「为什么」而不是「是什么」。
短句不值得入库，导入管线会丢弃长度小于 8 的噪声块。
`

export async function runSmoke(win: BrowserWindow, tempDir: string): Promise<number> {
  const artifacts = join(process.cwd(), 'smoke-artifacts')
  await mkdir(artifacts, { recursive: true })
  await mkdir(tempDir, { recursive: true })

  // 1. 等待渲染进程就绪
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const ready = await win.webContents
      .executeJavaScript('typeof window.__mhAppReady__ !== "undefined" && typeof window.__mhSmoke__ !== "undefined"')
      .catch(() => false)
    if (ready === true) break
    await delay(200)
  }

  // 2. 注入临时目录 + 准备导入样本
  await writeFile(join(tempDir, 'sample-import.md'), SAMPLE_MARKDOWN, 'utf8')
  await win.webContents.executeJavaScript(`window.__mhSmoke__.configure(${JSON.stringify(tempDir)})`)

  // 3. 逐步驱动 + 截图
  const count = (await win.webContents.executeJavaScript('window.__mhSmoke__.count')) as number
  const shots: Array<{ name: string; bytes: number }> = []
  let failures = 0
  for (let i = 0; i < count; i++) {
    const result = (await win.webContents.executeJavaScript(`window.__mhSmoke__.run(${i})`)) as {
      name: string
      ok: boolean
      error?: string
    }
    if (result.name === '') break
    const bytes = await capture(win, join(artifacts, `${result.name}.png`))
    shots.push({ name: result.name, bytes })
    if (!result.ok) {
      failures++
      console.error(`[smoke] FAIL ${result.name}: ${result.error ?? 'unknown'}`)
    } else {
      console.log(`[smoke] ok   ${result.name} (shot ${bytes} bytes)`)
    }
  }

  // 4. 导出工件存在性核验（ioExportJson / ioExportHtml 由 10/11 步触发，路径由对话框替身决定）
  const files = await readdir(tempDir).catch(() => [] as string[])
  for (const pattern of [/^memories-.*\.json$/, /^memories-view-.*\.html$/]) {
    const hit = files.find((f) => pattern.test(f))
    console.log(hit ? `[smoke] artifact ${join(tempDir, hit)}` : `[smoke] missing export artifact ${pattern}`)
    if (hit === undefined) failures++
  }

  const shotOk = shots.filter((s) => s.bytes > 8_000).length
  console.log(`[smoke] 截图 ${shots.length} 张（有效 ${shotOk}）· 失败步骤 ${failures} · 工件目录 ${artifacts}`)
  const emptyShots = shots.filter((s) => s.bytes <= 8_000).map((s) => s.name)
  if (emptyShots.length > 0) console.warn(`[smoke] 可疑空白截图: ${emptyShots.join(', ')}`)
  return failures === 0 && shots.length >= 10 && shotOk === shots.length ? 0 : 1
}

async function capture(win: BrowserWindow, target: string): Promise<number> {
  await win.webContents
    .executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
    .catch(() => {})
  let image = await win.webContents.capturePage()
  if (image.isEmpty() || image.toPNG().length < 8_000) {
    // 隐藏窗口偶尔不出帧：短暂显示后重拍（仍失败则记录空图，由门禁判失败）
    win.show()
    await delay(400)
    image = await win.webContents.capturePage()
    win.hide()
  }
  const png = image.toPNG()
  await writeFile(target, png)
  return png.length
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
