/**
 * 无头冒烟驱动（渲染进程侧）：以真实 DOM 交互驱动完整用户旅程
 *
 * 主进程通过 executeJavaScript 逐步推进（window.__mhSmoke__.run(i)），
 * 每步完成后主进程截图留证。驱动只使用与真实用户相同的控件（data-testid 定位），
 * 等待条件一律以**渲染后的 DOM** 为准（不读应用内部状态）——所见即所验。
 */
import type { App } from './app'

interface SmokeStep {
  name: string
  run: (ctx: SmokeContext) => Promise<void>
}

interface SmokeContext {
  tempDir: string
}

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel)
  if (el === null) throw new Error(`smoke: 未找到元素 ${sel}`)
  return el
}

const $$ = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(sel)]

const entries = (): HTMLElement[] => $$('[data-entry-id]')

async function waitFor(cond: () => boolean, timeout = 20_000, step = 60, label = ''): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error(`smoke: 等待超时（${timeout}ms）${label ? ` @ ${label}` : ''}`)
    await new Promise((r) => setTimeout(r, step))
  }
}

const modalGone = (name: string): boolean => document.querySelector(`[data-modal="${name}"]`) === null

async function typeInput(sel: string, value: string): Promise<void> {
  const el = $(sel) as HTMLInputElement | HTMLTextAreaElement
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function click(sel: string): Promise<void> {
  $(sel).click()
}

/** 通过侧栏 DOM 找到目标库（名称匹配）并点击激活 */
async function activateLibraryByName(name: string): Promise<void> {
  const item = $$('[data-testid="lib-item"]').find((el) => el.querySelector('.lib-name')?.textContent === name)
  if (item === undefined) throw new Error(`smoke: 侧栏未找到库「${name}」`)
  item.click()
}

function joinPath(dir: string, name: string): string {
  return dir.includes('\\') && !dir.includes('/')
    ? `${dir.replace(/\\+$/, '')}\\${name}`
    : `${dir.replace(/\/+$/, '')}/${name}`
}

const LIB_NAME = 'smoke-library'

export function installSmokeDriver(_app: App): void {
  let tempDir = ''
  const steps: SmokeStep[] = [
    {
      name: '01-库列表与空态',
      run: async () => {
        await waitFor(() => $$('[data-testid="lib-item"]').length >= 1, 20_000, 60, 'lib-item 出现')
        // 默认库自动激活 → 列表区就绪（空态或列表）
        await waitFor(() => document.querySelector('[data-testid="entry-list"]') !== null, 10_000, 60, '列表区就绪')
      },
    },
    {
      name: '02-新建库',
      run: async (ctx) => {
        await click('[data-testid="add-library"]')
        await waitFor(() => document.querySelector('[data-modal="add-library"]') !== null, 10_000, 60, '新建库弹窗')
        await typeInput('[data-testid="library-path"]', joinPath(ctx.tempDir, `${LIB_NAME}.jsonl`))
        await click('[data-testid="library-submit"]')
        await waitFor(() => modalGone('add-library'), 15_000, 60, '弹窗关闭')
        // 顶栏切换到新库 + 空列表
        await waitFor(
          () => $('[data-testid="active-lib"]').textContent?.includes(LIB_NAME) === true,
          15_000,
          60,
          '顶栏显示新库',
        )
        await waitFor(() => entries().length === 0 && $('.list-pane').textContent !== '', 10_000, 60, '空列表')
      },
    },
    {
      name: '03-新建记忆',
      run: async () => {
        const contents = [
          '项目 dsh-memory-hub 的构建命令是 pnpm build，测试入口 npm test',
          '用户偏好：所有代码注释使用中文，遵循 prettier 单引号无分号风格',
          '决策：GUI 采用 Electron 主进程直连 JsonlMemoryStore，零运行时第三方依赖',
        ]
        for (const content of contents) {
          await click('[data-testid="new-entry"]')
          await waitFor(() => document.querySelector('[data-modal="entry-editor"]') !== null, 10_000, 60, '编辑器弹窗')
          await typeInput('[data-testid="editor-content"]', content)
          await click('[data-testid="editor-submit"]')
          await waitFor(() => modalGone('entry-editor'), 20_000, 60, '编辑器关闭')
          // 每条落库并渲染后再继续（DOM 计数递增）
          const expect = contents.indexOf(content) + 1
          await waitFor(() => entries().length >= expect, 20_000, 60, `第 ${expect} 条渲染`)
        }
      },
    },
    {
      name: '04-检索命中',
      run: async () => {
        await typeInput('[data-testid="search-input"]', '构建命令是什么')
        // 检索态：出现评分条且命中条目
        await waitFor(
          () => document.querySelector('.score-row') !== null && entries().length >= 1,
          20_000,
          60,
          '检索结果与评分条',
        )
      },
    },
    {
      name: '05-召回溯源',
      run: async () => {
        entries()[0].click()
        await waitFor(() => document.querySelector('.detail-content') !== null, 10_000, 60, '详情面板')
      },
    },
    {
      name: '06-编辑记忆',
      run: async () => {
        await click('[data-testid="detail-edit"]')
        await waitFor(() => document.querySelector('[data-modal="entry-editor"]') !== null, 10_000, 60, '编辑器弹窗')
        const textarea = $('[data-testid="editor-content"]') as HTMLTextAreaElement
        await typeInput('[data-testid="editor-content"]', `${textarea.value}（已复核 v1.6）`)
        await click('[data-testid="editor-submit"]')
        await waitFor(() => modalGone('entry-editor'), 20_000, 60, '编辑器关闭')
        await waitFor(() => $('.detail-pane').textContent?.includes('已复核 v1.6') === true, 20_000, 60, '详情含新内容')
      },
    },
    {
      name: '07-取代旧版本',
      run: async () => {
        // 清空检索回到全量列表
        const search = $('[data-testid="search-input"]') as HTMLInputElement
        search.value = ''
        search.dispatchEvent(new Event('input', { bubbles: true }))
        await waitFor(
          () => document.querySelector('.score-row') === null && entries().length >= 3,
          20_000,
          60,
          '回到全量列表',
        )
        entries()[1].click()
        await waitFor(() => document.querySelector('.detail-actions') !== null, 10_000, 60, '详情操作区')
        await click('[data-testid="detail-supersede"]')
        await waitFor(() => document.querySelector('[data-modal="supersede-editor"]') !== null, 10_000, 60, '取代弹窗')
        const textarea = $('[data-testid="editor-content"]') as HTMLTextAreaElement
        await typeInput('[data-testid="editor-content"]', `取代更新：${textarea.value}`)
        await click('[data-testid="editor-submit"]')
        await waitFor(() => modalGone('supersede-editor'), 20_000, 60, '取代弹窗关闭')
        await waitFor(() => document.querySelector('.badge.superseded') !== null, 20_000, 60, '「已被取代」徽标')
      },
    },
    {
      name: '08-删除记忆',
      run: async () => {
        const before = entries().length
        entries()[entries().length - 1].click()
        await waitFor(() => document.querySelector('.detail-actions') !== null, 10_000, 60, '详情操作区')
        await click('[data-testid="detail-delete"]')
        await waitFor(() => document.querySelector('[data-modal="confirm"]') !== null, 10_000, 60, '确认弹窗')
        await click('[data-testid="confirm-yes"]')
        await waitFor(() => modalGone('confirm'), 15_000, 60, '确认弹窗关闭')
        await waitFor(() => entries().length === before - 1, 20_000, 60, '列表条数减一')
      },
    },
    {
      name: '09-导入向导',
      run: async () => {
        const before = entries().length
        await click('[data-testid="import-btn"]')
        await waitFor(() => document.querySelector('[data-modal="import-wizard"]') !== null, 10_000, 60, '导入弹窗')
        await click('[data-testid="import-pick"]')
        await waitFor(
          () => $('[data-testid="import-path"]').textContent?.includes('sample-import') === true,
          10_000,
          60,
          '文件路径回显',
        )
        await click('[data-testid="import-preview"]')
        await waitFor(() => document.querySelector('[data-testid="import-stats"]') !== null, 20_000, 60, '入库计划预览')
        await click('[data-testid="import-commit"]')
        await waitFor(() => modalGone('import-wizard'), 30_000, 60, '导入完成弹窗关闭')
        await waitFor(() => entries().length > before, 20_000, 60, '导入后条数增加')
      },
    },
    {
      name: '10-导出迁移包',
      run: async () => {
        await click('[data-testid="export-btn"]')
        await waitFor(() => document.querySelector('[data-modal="export-dialog"]') !== null, 10_000, 60, '导出弹窗')
        await click('[data-testid="export-json"]')
        await waitFor(() => modalGone('export-dialog'), 20_000, 60, '导出弹窗关闭')
      },
    },
    {
      name: '11-导出可视化页',
      run: async () => {
        await click('[data-testid="export-btn"]')
        await waitFor(() => document.querySelector('[data-modal="export-dialog"]') !== null, 10_000, 60, '导出弹窗')
        await click('[data-testid="export-html"]')
        await waitFor(() => modalGone('export-dialog'), 20_000, 60, '导出弹窗关闭')
      },
    },
    {
      name: '12-维护统计',
      run: async () => {
        await click('[data-testid="view-maintenance"]')
        await waitFor(() => document.querySelector('[data-testid="stats-grid"]') !== null, 20_000, 60, '统计卡片')
        await waitFor(() => document.querySelector('[data-testid="timeline"]') !== null, 20_000, 60, '时间轴')
      },
    },
    {
      name: '13-启用加密',
      run: async () => {
        await click('[data-testid="view-memory"]')
        await waitFor(() => document.querySelector('[data-testid="search-input"]') !== null, 10_000, 60, '回到记忆视图')
        await click('[data-testid="passphrase-btn"]')
        await waitFor(
          () => document.querySelector('[data-modal="passphrase-manage"]') !== null,
          10_000,
          60,
          '口令管理弹窗',
        )
        const inputs = $$('[data-modal="passphrase-manage"] input[type="password"]')
        ;(inputs[0] as HTMLInputElement).value = 'smoke-passphrase-🔥'
        ;(inputs[1] as HTMLInputElement).value = 'smoke-passphrase-🔥'
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }))
        await click('[data-testid="passphrase-apply"]')
        await waitFor(() => modalGone('passphrase-manage'), 30_000, 60, '加密迁移完成')
        // 顶栏出现「加密」相关徽标（已解锁）
        await waitFor(
          () => $('[data-testid="active-lib"]').textContent?.includes('加密') === true,
          20_000,
          60,
          '加密徽标',
        )
      },
    },
    {
      name: '14-锁库',
      run: async () => {
        await click('[data-testid="lock-btn"]')
        // 顶栏失去「已解锁」态
        await waitFor(
          () => ($('[data-testid="active-lib"]').textContent?.includes('已解锁') ?? true) === false,
          10_000,
          60,
          '顶栏失去已解锁态',
        )
      },
    },
    {
      name: '15-口令解锁',
      run: async () => {
        await activateLibraryByName(LIB_NAME)
        await waitFor(
          () => document.querySelector('[data-modal="passphrase-prompt"]') !== null,
          15_000,
          60,
          '口令输入弹窗',
        )
        await typeInput('[data-testid="passphrase-input"]', 'smoke-passphrase-🔥')
        await click('[data-testid="passphrase-submit"]')
        await waitFor(() => modalGone('passphrase-prompt'), 30_000, 60, '口令弹窗关闭')
        await waitFor(() => entries().length >= 1, 30_000, 60, '解锁后列表可见')
        await waitFor(
          () => $('[data-testid="active-lib"]').textContent?.includes('已解锁') === true,
          20_000,
          60,
          '已解锁徽标',
        )
      },
    },
    {
      name: '16-解密回退收尾',
      run: async () => {
        await click('[data-testid="passphrase-btn"]')
        await waitFor(
          () => document.querySelector('[data-modal="passphrase-manage"]') !== null,
          10_000,
          60,
          '口令管理弹窗',
        )
        // 两次输入均留空 = 解密回退
        await click('[data-testid="passphrase-apply"]')
        await waitFor(() => modalGone('passphrase-manage'), 30_000, 60, '解密回退完成')
        await waitFor(
          () => ($('[data-testid="active-lib"]').textContent?.includes('加密') ?? true) === false,
          20_000,
          60,
          '加密徽标消失',
        )
      },
    },
  ]

  ;(window as unknown as Record<string, unknown>).__mhSmoke__ = {
    configure(dir: string): void {
      tempDir = dir
    },
    get count(): number {
      return steps.length
    },
    async run(i: number): Promise<{ name: string; ok: boolean; error?: string }> {
      const step = steps[i]
      if (step === undefined) return { name: '', ok: true }
      try {
        await step.run({ tempDir })
        return { name: step.name, ok: true }
      } catch (err) {
        return { name: step.name, ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
