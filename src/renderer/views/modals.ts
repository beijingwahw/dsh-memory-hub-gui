/**
 * 模态框集合：编辑器（新建/编辑/取代）/ 导入向导 / 导出 / 口令管理 / 新建·添加库 / 确认框
 *
 * 全部返回 Promise（用户确认 resolve / 取消 reject(undefined)），DOM 均经 textContent。
 * data-modal 属性供无头冒烟驱动定位。
 */
import { h, clear, icon } from '../dom'
import { kindLabel, parseTags, userTags, supersededBy, summarizeEntry } from '../model'
import { ApiError, api } from '../api'
import type { ImportPreviewResult, LibrarySummary, MemoryEntry, MemoryKind } from '../../shared/protocol'

/* ------------------------------ 基础设施 ------------------------------ */

export function openModal(name: string, build: (modal: HTMLElement, close: <T>(v?: T) => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const backdrop = h('div', { class: 'modal-backdrop', 'data-modal': name })
    const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' })
    const done = <T>(v?: T) => {
      backdrop.remove()
      resolve(v as void)
    }
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) done()
    })
    document.addEventListener('keydown', function esc(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', esc)
        done()
      }
    })
    build(modal, done)
    backdrop.append(modal)
    document.body.append(backdrop)
    const focusable = modal.querySelector<HTMLElement>('input, textarea, select, button')
    focusable?.focus()
  })
}

function formRow(label: string, control: HTMLElement, hint?: HTMLElement): HTMLElement {
  return h('label', { class: 'form-row' }, h('span', { class: 'form-label' }, label), control, ...(hint ? [hint] : []))
}

function errLine(): { el: HTMLElement; show: (msg: string) => void; hide: () => void } {
  const el = h('div', { class: 'form-error', role: 'alert' })
  el.style.display = 'none'
  return {
    el,
    show: (msg: string) => {
      el.textContent = msg
      el.style.display = ''
    },
    hide: () => {
      el.style.display = 'none'
      el.textContent = ''
    },
  }
}

const KIND_OPTIONS: MemoryKind[] = ['generic', 'fact', 'decision', 'preference', 'instruction']

function kindSelect(id: string, selected?: MemoryKind): HTMLSelectElement {
  const sel = h('select', { id, class: 'input' }) as HTMLSelectElement
  for (const k of KIND_OPTIONS) {
    const opt = h('option', { value: k }, kindLabel(k)) as HTMLOptionElement
    if (k === (selected ?? 'generic')) opt.selected = true
    sel.append(opt)
  }
  return sel
}

/* ------------------------------ 编辑器（新建/编辑/取代） ------------------------------ */

export interface EditorResult {
  content: string
  kind: MemoryKind
  tags: string[]
  workspace: string
}

/**
 * 新建 / 编辑 / 取代 三形态编辑器。
 * supersedeOf 传入 = 取代模式（正文预填旧内容，标题与按钮语义变化）。
 */
export function editorModal(opts: {
  mode: 'create' | 'edit' | 'supersede'
  entry?: MemoryEntry
  defaultWorkspace?: string
}): Promise<EditorResult> {
  return new Promise((resolve, reject) => {
    const isSupersede = opts.mode === 'supersede'
    void openModal(isSupersede ? 'supersede-editor' : 'entry-editor', (modal, close) => {
      const title =
        opts.mode === 'create' ? '新建记忆' : isSupersede ? '取代旧记忆（写入新版本并降权旧条目）' : '编辑记忆'
      const content = h('textarea', {
        class: 'input textarea',
        rows: '6',
        placeholder: '一句完整的自然语言，例如：项目 X 的构建命令是 pnpm build',
        'data-testid': 'editor-content',
      }) as HTMLTextAreaElement
      content.value = isSupersede ? opts.entry!.content : (opts.entry?.content ?? '')
      const kind = kindSelect('editor-kind', opts.entry?.kind ?? (isSupersede ? opts.entry!.kind : undefined))
      const tags = h('input', {
        class: 'input',
        type: 'text',
        placeholder: '逗号或空格分隔，如：构建, 项目X',
        'data-testid': 'editor-tags',
      }) as HTMLInputElement
      tags.value = userTags({ tags: opts.entry?.tags ?? [] }).join(', ')
      const workspace = h('input', {
        class: 'input',
        type: 'text',
        placeholder: '（可选）工作区名称，用于会话级隔离',
      }) as HTMLInputElement
      workspace.value = opts.entry?.workspace ?? opts.defaultWorkspace ?? ''
      const err = errLine()
      const submit = h(
        'button',
        { class: 'btn primary', 'data-testid': 'editor-submit' },
        isSupersede ? '写入新版本' : '保存',
      )
      submit.addEventListener('click', () => {
        const trimmed = content.value.trim()
        if (!trimmed) {
          err.show('内容不能为空')
          return
        }
        close()
        resolve({
          content: trimmed,
          kind: kind.value as MemoryKind,
          tags: parseTags(tags.value),
          workspace: workspace.value.trim(),
        })
      })
      const cancel = h('button', { class: 'btn', type: 'button' }, '取消')
      cancel.addEventListener('click', () => {
        close()
        reject(undefined)
      })
      modal.append(
        h('h3', {}, title),
        h(
          'div',
          { class: 'modal-body' },
          formRow('内容', content),
          h('div', { class: 'form-grid' }, formRow('类型', kind), formRow('标签', tags)),
          formRow('工作区', workspace),
          err.el,
        ),
        h('div', { class: 'modal-actions' }, cancel, submit),
      )
    }).catch(() => reject(undefined))
  })
}

/* ------------------------------ 导入向导 ------------------------------ */

const IMPORT_KIND_LABELS: Record<string, string> = {
  markdown: 'Markdown / 文本文档',
  session: '会话日志 JSONL',
  json: 'JSON 迁移包（exportAll 导出）',
}

export function importWizard(): Promise<{ imported: number } | undefined> {
  return new Promise((resolve) => {
    let kind: 'markdown' | 'session' | 'json' = 'markdown'
    let pickedPath: string | undefined
    let preview: ImportPreviewResult | undefined
    let currentMode = 'balanced'
    void openModal('import-wizard', (modal, close) => {
      const done = (v?: { imported: number }) => {
        close()
        resolve(v)
      }
      const body = h('div', { class: 'modal-body' })
      const err = errLine()
      const render = (): void => {
        clear(body)
        clear(err.el)
        err.hide()

        const kindSel = h('select', { class: 'input', 'data-testid': 'import-kind' }) as HTMLSelectElement
        for (const [value, label] of Object.entries(IMPORT_KIND_LABELS)) {
          const opt = h('option', { value: label }) as HTMLOptionElement
          opt.value = value
          opt.textContent = label
          if (value === kind) opt.selected = true
          kindSel.append(opt)
        }
        kindSel.addEventListener('change', () => {
          kind = kindSel.value as typeof kind
          pickedPath = undefined
          preview = undefined
          render()
        })

        const modeSel = h('select', { class: 'input' }) as HTMLSelectElement
        for (const [value, label] of [
          ['conservative', '保守（只收明确信号）'],
          ['balanced', '均衡（推荐）'],
          ['aggressive', '激进（多收候选）'],
        ] as const) {
          const opt = h('option', { value: label }) as HTMLOptionElement
          opt.value = value
          opt.textContent = label
          if (value === 'balanced') opt.selected = true
          modeSel.append(opt)
        }
        modeSel.addEventListener('change', () => (currentMode = modeSel.value))
        if (kind === 'json') modeSel.disabled = true

        const pickBtn = h('button', { class: 'btn', 'data-testid': 'import-pick' }, icon('upload'), '选择文件…')
        const pathLine = h('div', { class: 'path-line', 'data-testid': 'import-path' }, pickedPath ?? '未选择文件')
        pickBtn.addEventListener('click', async () => {
          const p = await api.ioPickOpen(kind)
          if (p) {
            pickedPath = p
            preview = undefined
            render()
          }
        })

        const previewBtn = h('button', { class: 'btn primary', 'data-testid': 'import-preview' }, '预览入库计划')
        previewBtn.disabled = pickedPath === undefined
        previewBtn.addEventListener('click', async () => {
          if (!pickedPath) return
          previewBtn.disabled = true
          try {
            preview = await api.ioImportPreview({ kind, path: pickedPath, mode: modeSel.value })
            render()
          } catch (e) {
            err.show(e instanceof Error ? e.message : String(e))
            previewBtn.disabled = false
          }
        })

        body.append(
          formRow('导入来源', kindSel),
          formRow(kind === 'json' ? '信号词模式' : '信号词模式（markdown / 会话）', modeSel),
          h(
            'div',
            { class: 'form-row' },
            h('span', { class: 'form-label' }, '文件'),
            h('div', { class: 'inline' }, pickBtn, previewBtn, pathLine),
          ),
          err.el,
        )

        if (preview) {
          const s = preview.stats
          const statsGrid = h(
            'div',
            { class: 'stats-grid', 'data-testid': 'import-stats' },
            statCard('计划入库', String(preview.planned), 'primary'),
            statCard('候选总量', String(s.total)),
            statCard('太短丢弃', String(s.droppedShort)),
            statCard('敏感拦截', String(s.droppedSensitive)),
            statCard('重复拒绝', String(s.droppedDuplicate)),
            ...(kind === 'session' ? [statCard('损坏行', String(s.corruptLines))] : []),
            ...(kind === 'json'
              ? [statCard('结构非法', String(s.invalidEntries ?? 0)), statCard('id 已存在', String(s.existingIds ?? 0))]
              : []),
          )
          const sampleList = h(
            'ul',
            { class: 'sample-list' },
            ...preview.sample
              .slice(0, 8)
              .map((e) =>
                h('li', {}, h('span', { class: `kind-badge k-${e.kind}` }, kindLabel(e.kind)), summarizeEntry(e, 80)),
              ),
          )
          body.append(h('h4', {}, '入库计划预览'), statsGrid, h('h4', {}, '样例（至多 8 条）'), sampleList)
        }
      }
      render()

      const commitBtn = h(
        'button',
        { class: 'btn primary', 'data-testid': 'import-commit' },
        icon('upload'),
        '执行导入',
      )
      commitBtn.addEventListener('click', async () => {
        if (!pickedPath) return
        commitBtn.disabled = true
        commitBtn.textContent = '导入中…'
        try {
          const r = await api.ioImportCommit({ kind, path: pickedPath, mode: currentMode })
          done({ imported: r.imported })
        } catch (e) {
          err.show(e instanceof Error ? e.message : String(e))
          commitBtn.disabled = false
          commitBtn.textContent = '执行导入'
        }
      })
      const cancel = h('button', { class: 'btn' }, '关闭')
      cancel.addEventListener('click', () => done(undefined))
      modal.append(h('h3', {}, '导入记忆'), body, h('div', { class: 'modal-actions' }, cancel, commitBtn))
    })
  })
}

/* ------------------------------ 导出对话框 ------------------------------ */

export function exportDialog(activeLib: LibrarySummary | undefined): Promise<void> {
  return new Promise((resolve) => {
    void openModal('export-dialog', (modal, close) => {
      const done = () => {
        close()
        resolve()
      }
      const err = errLine()
      const stamp = new Date().toISOString().slice(0, 10)
      const jsonBtn = h('button', { class: 'btn', 'data-testid': 'export-json' }, icon('download'), 'JSON 迁移包')
      jsonBtn.addEventListener('click', async () => {
        const target = await api.ioPickSave('json', `memories-${stamp}.json`)
        if (target === null) return
        try {
          const r = await api.ioExportJson(target)
          toast(`已导出 JSON 迁移包：${r.path}（${r.count ?? '?'} 条 · ${(r.bytes / 1024).toFixed(1)} KB）`)
          done()
        } catch (e) {
          err.show(e instanceof Error ? e.message : String(e))
        }
      })
      const htmlBtn = h(
        'button',
        { class: 'btn', 'data-testid': 'export-html' },
        icon('download'),
        '可视化检索页（HTML）',
      )
      htmlBtn.addEventListener('click', async () => {
        const target = await api.ioPickSave('html', `memories-view-${stamp}.html`)
        if (target === null) return
        try {
          const r = await api.ioExportHtml(target)
          toast(`已导出可视化检索页：${r.path}（${(r.bytes / 1024).toFixed(1)} KB）`)
          done()
        } catch (e) {
          err.show(e instanceof Error ? e.message : String(e))
        }
      })
      const warn = h(
        'p',
        { class: 'hint warn' },
        '注意：导出文件为明文观看工件（与加密存储正交）——请自行妥善保管；HTML 页自包含、可离线打开、检索在浏览器本地进行。',
      )
      const libLine = activeLib
        ? h('p', { class: 'hint' }, `当前库：${activeLib.name}（${activeLib.filePath}）`)
        : undefined
      modal.append(
        h('h3', {}, '导出'),
        h(
          'div',
          { class: 'modal-body' },
          libLine,
          h('div', { class: 'export-buttons' }, jsonBtn, htmlBtn),
          warn,
          err.el,
        ),
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: done }, '关闭')),
      )
    })
  })
}

/* ------------------------------ 口令（打开解锁 / 加密管理） ------------------------------ */

/** 解锁弹窗：打开加密库缺口令 / 口令错误时弹出，resolve 口令或 undefined（取消） */
export function passphrasePrompt(reason: 'needed' | 'wrong', libName: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    void openModal('passphrase-prompt', (modal, close) => {
      const input = h('input', {
        class: 'input',
        type: 'password',
        placeholder: '记忆库口令',
        autocomplete: 'off',
        'data-testid': 'passphrase-input',
      }) as HTMLInputElement
      const err = errLine()
      if (reason === 'wrong') err.show('口令错误或库文件被篡改，请重试')
      const submit = h('button', { class: 'btn primary', 'data-testid': 'passphrase-submit' }, '解锁')
      const submitIt = (): void => {
        if (!input.value) {
          err.show('请输入口令')
          return
        }
        close()
        resolve(input.value)
      }
      submit.addEventListener('click', submitIt)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitIt()
      })
      const cancel = h('button', { class: 'btn' }, '取消')
      cancel.addEventListener('click', () => {
        close()
        resolve(undefined)
      })
      modal.append(
        h('h3', {}, `解锁加密库：${libName}`),
        h(
          'div',
          { class: 'modal-body' },
          h('p', { class: 'hint' }, '口令仅在主进程内存中持有，不会写入磁盘或日志。'),
          formRow('口令', input),
          err.el,
        ),
        h('div', { class: 'modal-actions' }, cancel, submit),
      )
    })
  })
}

/** 口令管理：启用加密 / 轮换 / 解密回退（活动库） */
export function passphraseManage(active: { name: string; encrypted: boolean; unlocked: boolean }): Promise<void> {
  return new Promise((resolve) => {
    void openModal('passphrase-manage', (modal, close) => {
      const done = () => {
        close()
        resolve()
      }
      const err = errLine()
      const input = h('input', {
        class: 'input',
        type: 'password',
        placeholder: '新口令（留空 = 解密回退为明文库）',
        autocomplete: 'new-password',
      }) as HTMLInputElement
      const confirmInput = h('input', {
        class: 'input',
        type: 'password',
        placeholder: '再次输入新口令',
        autocomplete: 'new-password',
      }) as HTMLInputElement
      const apply = h('button', { class: 'btn primary', 'data-testid': 'passphrase-apply' }, '应用')
      apply.addEventListener('click', async () => {
        if (input.value !== confirmInput.value) {
          err.show('两次输入不一致')
          return
        }
        try {
          await api.libPassphrase({ next: input.value })
          toast(input.value ? '口令已更新（逐行重加密完成，深回放历史保留）' : '已解密回退为明文库')
          done()
        } catch (e) {
          err.show(e instanceof Error ? e.message : String(e))
        }
      })
      const state = active.encrypted
        ? active.unlocked
          ? '当前库已加密（已解锁）——可轮换口令或解密回退。'
          : '当前库已加密（未解锁）。'
        : '当前库为明文存储——设置口令即原位加密（历史版本逐行保留）。'
      modal.append(
        h('h3', {}, `口令管理：${active.name}`),
        h(
          'div',
          { class: 'modal-body' },
          h('p', { class: 'hint' }, state),
          h('p', { class: 'hint warn' }, '口令丢失 = 数据不可恢复（scrypt + AES-256-GCM，无后门）——这是特性不是缺陷。'),
          formRow('新口令', input),
          formRow('确认', confirmInput),
          err.el,
        ),
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: done }, '关闭'), apply),
      )
    })
  })
}

/* ------------------------------ 新建 / 添加库 ------------------------------ */

export function addLibraryModal(): Promise<{ action: 'create' | 'open'; filePath: string } | undefined> {
  return new Promise((resolve) => {
    let action: 'create' | 'open' = 'create'
    void openModal('add-library', (modal, close) => {
      const body = h('div', { class: 'modal-body' })
      const err = errLine()
      const render = (): void => {
        clear(body)
        const tabs = h(
          'div',
          { class: 'tab-row' },
          h(
            'button',
            { class: `tab ${action === 'create' ? 'active' : ''}`, onclick: () => ((action = 'create'), render()) },
            '新建空库',
          ),
          h(
            'button',
            { class: `tab ${action === 'open' ? 'active' : ''}`, onclick: () => ((action = 'open'), render()) },
            '添加已有库',
          ),
        )
        const input = h('input', {
          class: 'input',
          type: 'text',
          placeholder:
            action === 'create' ? 'D:\\memories\\work.jsonl' : 'C:\\Users\\me\\.dsh\\memory-hub\\memories.jsonl',
          'data-testid': 'library-path',
        }) as HTMLInputElement
        const pick = h('button', { class: 'btn' }, '浏览…')
        pick.addEventListener('click', async () => {
          const p = await api.ioPickOpen('json')
          if (p) input.value = p
        })
        const hint = h(
          'p',
          { class: 'hint' },
          action === 'create'
            ? '将创建目录与空记忆库文件（目标文件已存在且非空时拒绝，防误覆盖）。'
            : '注册一个既有 .jsonl 记忆库（加密库注册后首次打开时会请求口令）。',
        )
        body.append(tabs, formRow('库文件路径（.jsonl）', h('div', { class: 'inline' }, input, pick)), hint, err.el)
        submit.textContent = action === 'create' ? '创建' : '添加'
      }
      const submit = h('button', { class: 'btn primary', 'data-testid': 'library-submit' })
      submit.addEventListener('click', () => {
        const input = body.querySelector<HTMLInputElement>('[data-testid="library-path"]')!
        const filePath = input.value.trim()
        if (!filePath.toLowerCase().endsWith('.jsonl')) {
          err.show('路径应以 .jsonl 结尾')
          return
        }
        close()
        resolve({ action, filePath })
      })
      render()
      modal.append(
        h('h3', {}, '多库管理'),
        body,
        h(
          'div',
          { class: 'modal-actions' },
          h('button', { class: 'btn', onclick: () => (close(), resolve(undefined)) }, '取消'),
          submit,
        ),
      )
    })
  })
}

/* ------------------------------ 确认框 ------------------------------ */

export function confirmModal(title: string, message: string, confirmText = '确认'): Promise<boolean> {
  return new Promise((resolve) => {
    void openModal('confirm', (modal, close) => {
      const yes = h('button', { class: 'btn danger', 'data-testid': 'confirm-yes' }, confirmText)
      yes.addEventListener('click', () => {
        close()
        resolve(true)
      })
      const no = h('button', { class: 'btn' }, '取消')
      no.addEventListener('click', () => {
        close()
        resolve(false)
      })
      modal.append(
        h('h3', {}, title),
        h('div', { class: 'modal-body' }, h('p', {}, message)),
        h('div', { class: 'modal-actions' }, no, yes),
      )
    })
  })
}

/* ------------------------------ 轻提示 ------------------------------ */

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, message)
  document.body.append(el)
  setTimeout(() => el.classList.add('show'), 10)
  setTimeout(
    () => {
      el.classList.remove('show')
      setTimeout(() => el.remove(), 300)
    },
    kind === 'error' ? 6000 : 3800,
  )
}

export function statCard(label: string, value: string, tone?: 'primary'): HTMLElement {
  return h(
    'div',
    { class: `stat-card ${tone === 'primary' ? 'tone' : ''}` },
    h('div', { class: 'stat-value' }, value),
    h('div', { class: 'stat-label' }, label),
  )
}

export { supersededBy }
export type { ApiError }
