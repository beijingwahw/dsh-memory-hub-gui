/**
 * 应用编排：状态 + 布局骨架（侧栏 / 顶栏 / 内容区）+ 激活/解锁/刷新流转
 *
 * 刷新策略：工具栏与侧栏仅在其数据变化时重建；记忆列表/详情/筛选行在每次
 * 数据刷新时局部重绘（保持检索输入焦点）。
 */
import { h, clear, icon, fmtBytes } from './dom'
import { api, ApiError } from './api'
import { renderMemoryView, renderList, renderDetail, errText } from './views/memory-view'
import { renderMaintenanceView } from './views/maintenance-view'
import {
  addLibraryModal,
  confirmModal,
  exportDialog,
  importWizard,
  passphraseManage,
  passphrasePrompt,
  toast,
} from './views/modals'
import type {
  ListParams,
  ListResult,
  LibrarySummary,
  StatusResult,
  MemoryEntry,
  MemoryKind,
  MemorySource,
} from '../shared/protocol'

export type ViewName = 'memory' | 'maintenance'

export class App {
  view: ViewName = 'memory'
  libs: LibrarySummary[] = []
  list: ListResult | undefined
  selectedId: string | undefined
  status: StatusResult | undefined
  listState: ListParams = { sort: 'updated', limit: 100, offset: 0 }

  private refs: {
    sidebar?: HTMLElement
    topbar?: HTMLElement
    content?: HTMLElement
    facetsRow?: HTMLElement
    listPane?: HTMLElement
    detailPane?: HTMLElement
  } = {}

  get active(): LibrarySummary | undefined {
    return this.libs.find((l) => l.active)
  }

  get selected(): MemoryEntry | undefined {
    return this.selectedId === undefined ? undefined : this.list?.items.find((e) => e.id === this.selectedId)
  }

  /* --------------------------------- 启动 --------------------------------- */

  async boot(): Promise<void> {
    try {
      this.libs = await api.libList()
    } catch (e) {
      toast(errText(e), 'error')
      return
    }
    this.renderShell()
    const initial = this.libs.find((l) => l.active) ?? this.libs[0]
    if (initial) await this.activate(initial)
    else this.renderAll()
    this.markReady()
  }

  private markReady(): void {
    ;(window as unknown as Record<string, unknown>).__mhAppReady__ = true
  }

  /* --------------------------------- 库流转 --------------------------------- */

  async activate(lib: LibrarySummary, passphrase?: string): Promise<void> {
    try {
      this.libs = await api.libActivate({ id: lib.id, ...(passphrase !== undefined ? { passphrase } : {}) })
      this.selectedId = undefined
      this.status = undefined
      this.listState = {
        sort: 'updated',
        limit: 100,
        offset: 0,
        ...(this.listState.query !== undefined ? { query: this.listState.query } : {}),
      }
      await this.refresh()
      this.renderShell()
    } catch (e) {
      if (e instanceof ApiError && (e.needsPassphrase || e.wrongPassphrase)) {
        const pw = await passphrasePrompt(e.wrongPassphrase ? 'wrong' : 'needed', lib.name)
        if (pw !== undefined) await this.activate(lib, pw)
        return
      }
      toast(errText(e), 'error')
    }
  }

  async lockActive(): Promise<void> {
    try {
      this.libs = await api.libLock()
      this.list = undefined
      this.selectedId = undefined
      this.status = undefined
      this.renderShell()
      toast('已锁库：口令已从内存清除，重新访问需再次输入')
    } catch (e) {
      toast(errText(e), 'error')
    }
  }

  async addLibrary(): Promise<void> {
    const r = await addLibraryModal()
    if (r === undefined) return
    try {
      this.libs =
        r.action === 'create'
          ? await api.libCreate({ filePath: r.filePath })
          : await api.libAdd({ filePath: r.filePath })
      const added = this.libs.find((l) =>
        l.filePath.replace(/\\/g, '/').endsWith(r.filePath.replace(/\\/g, '/').split('/').pop()!),
      )
      this.renderShell()
      if (added) await this.activate(added)
    } catch (e) {
      if (e instanceof ApiError && e.needsPassphrase) {
        // 注册成功但需口令：已入列表，稍后点击解锁
        this.libs = await api.libList().catch(() => this.libs)
        this.renderShell()
        return
      }
      toast(errText(e), 'error')
    }
  }

  async removeLibrary(lib: LibrarySummary): Promise<void> {
    const ok = await confirmModal('移出库列表', `仅从侧栏移除「${lib.name}」，不删除磁盘文件。`, '移出')
    if (!ok) return
    try {
      this.libs = await api.libRemove({ id: lib.id })
      if (!this.active) {
        this.list = undefined
        this.selectedId = undefined
      }
      this.renderShell()
      if (!this.active && this.libs[0]) await this.activate(this.libs[0])
    } catch (e) {
      toast(errText(e), 'error')
    }
  }

  async renameLibrary(lib: LibrarySummary): Promise<void> {
    const name = window.prompt('新的库名', lib.name)
    if (!name || name.trim() === lib.name) return
    try {
      this.libs = await api.libRename({ id: lib.id, name: name.trim() })
      this.renderShell()
    } catch (e) {
      toast(errText(e), 'error')
    }
  }

  /* --------------------------------- 列表状态 --------------------------------- */

  async setQuery(query: string): Promise<void> {
    this.listState = { ...this.listState, query: query.trim() || undefined, offset: 0, explain: true }
    await this.refreshList()
  }

  async setFilter(patch: {
    kind?: MemoryKind
    source?: MemorySource
    tag?: string
    workspace?: string
  }): Promise<void> {
    this.listState = { ...this.listState, ...patch, offset: 0 }
    await this.refreshList()
  }

  async setSort(sort: 'updated' | 'created' | 'heat'): Promise<void> {
    this.listState = { ...this.listState, sort, offset: 0 }
    await this.refreshList()
  }

  async loadMore(): Promise<void> {
    const current = this.list
    if (current === undefined) return
    const offset = current.offset + current.items.length
    const next = await api.entryList({ ...this.listState, offset } as Record<string, unknown>)
    this.list = { ...next, items: [...current.items, ...next.items] }
    this.renderContentParts()
  }

  select(id: string | undefined): void {
    this.selectedId = id
    if (this.refs.detailPane && this.view === 'memory') renderDetail(this, this.refs.detailPane)
    const items = this.refs.listPane?.querySelectorAll('.entry-item')
    items?.forEach((el) => el.classList.toggle('selected', el.getAttribute('data-entry-id') === id))
  }

  /* --------------------------------- 刷新 --------------------------------- */

  async refresh(): Promise<void> {
    const [libs, list] = await Promise.all([
      api.libList().catch(() => this.libs),
      this.active ? api.entryList(this.listState as Record<string, unknown>) : Promise.resolve(undefined),
    ])
    this.libs = libs
    this.list = list
    if (this.selectedId !== undefined && !this.list?.items.some((x) => x.id === this.selectedId))
      this.selectedId = undefined
    this.status = undefined
    this.renderShell()
  }

  async refreshList(): Promise<void> {
    if (!this.active) return
    try {
      this.list = await api.entryList(this.listState as Record<string, unknown>)
      if (this.selectedId !== undefined && !this.list.items.some((x) => x.id === this.selectedId))
        this.selectedId = undefined
      this.renderContentParts()
      this.renderSidebar() // 计数徽标
    } catch (e) {
      toast(errText(e), 'error')
    }
  }

  async loadStatus(): Promise<StatusResult> {
    this.status = await api.libStatus()
    return this.status
  }

  /* --------------------------------- 渲染 --------------------------------- */

  renderShell(): void {
    this.renderSidebar()
    this.renderTopbar()
    this.renderContent()
  }

  renderAll(): void {
    this.renderShell()
  }

  private renderSidebar(): void {
    const root = document.querySelector<HTMLElement>('.sidebar')
    if (!root) return
    clear(root)
    root.append(
      h(
        'header',
        { class: 'brand' },
        h('span', { class: 'brand-mark' }, '◈'),
        h(
          'div',
          {},
          h('div', { class: 'brand-name' }, 'DSH Memory Hub'),
          h('div', { class: 'brand-sub' }, '跨平台记忆管理'),
        ),
      ),
    )
    const listWrap = h('nav', { class: 'lib-list', 'data-testid': 'lib-list' })
    for (const lib of this.libs) {
      const encryptedBadge = lib.encrypted
        ? h('span', { class: 'badge', title: lib.open ? '已解锁' : '加密库（点击后输入口令）' }, lib.open ? '🔓' : '🔒')
        : undefined
      const count = lib.open ? `${lib.open.entryCount} 条` : lib.exists ? fmtBytes(lib.bytes) : '未创建'
      const item = h(
        'div',
        {
          class: `lib-item ${lib.active ? 'active' : ''}`,
          'data-testid': 'lib-item',
          'data-lib-id': lib.id,
          role: 'button',
          tabindex: '0',
        },
        h(
          'div',
          { class: 'lib-line' },
          h('span', { class: 'lib-name' }, lib.name),
          ...(encryptedBadge ? [encryptedBadge] : []),
          ...(lib.isDefault ? [h('span', { class: 'badge default' }, '默认')] : []),
        ),
        h('div', { class: 'lib-path', title: lib.filePath }, lib.filePath),
        h(
          'div',
          { class: 'lib-meta' },
          h('span', { class: 'meta-dim' }, count),
          h(
            'span',
            { class: 'lib-ops' },
            h(
              'button',
              {
                class: 'icon-btn',
                title: '重命名',
                onclick: (e) => (e.stopPropagation(), void this.renameLibrary(lib)),
              },
              '✎',
            ),
            ...(lib.isDefault
              ? []
              : [
                  h(
                    'button',
                    {
                      class: 'icon-btn',
                      title: '移出列表',
                      onclick: (e) => (e.stopPropagation(), void this.removeLibrary(lib)),
                    },
                    '✕',
                  ),
                ]),
          ),
        ),
      )
      item.addEventListener('click', () => {
        if (!lib.active) void this.activate(lib)
      })
      listWrap.append(item)
    }
    root.append(listWrap)
    root.append(
      h(
        'div',
        { class: 'sidebar-actions' },
        h(
          'button',
          { class: 'btn wide', 'data-testid': 'add-library', onclick: () => void this.addLibrary() },
          icon('plus'),
          '添加 / 新建库',
        ),
      ),
      h(
        'footer',
        { class: 'sidebar-footer' },
        h(
          'button',
          { class: 'btn wide', 'data-testid': 'import-btn', onclick: () => void this.runImport() },
          icon('upload'),
          '导入',
        ),
        h(
          'button',
          { class: 'btn wide', 'data-testid': 'export-btn', onclick: () => void exportDialog(this.active) },
          icon('download'),
          '导出',
        ),
      ),
    )
    this.refs.sidebar = root
  }

  private renderTopbar(): void {
    const root = document.querySelector<HTMLElement>('.topbar')
    if (!root) return
    clear(root)
    const lib = this.active
    root.append(
      h(
        'div',
        { class: 'topbar-lib', 'data-testid': 'active-lib' },
        h('span', { class: 'topbar-lib-name' }, lib ? lib.name : '未打开库'),
        ...(lib?.encrypted ? [h('span', { class: 'badge encrypt' }, lib.open ? '加密 · 已解锁' : '加密')] : []),
        ...(lib
          ? [h('span', { class: 'topbar-lib-count meta-dim' }, `${this.list?.total ?? lib.open?.entryCount ?? 0} 条`)]
          : []),
      ),
      h('div', { class: 'spacer' }),
      h(
        'div',
        { class: 'view-tabs', role: 'tablist' },
        h(
          'button',
          {
            class: `tab ${this.view === 'memory' ? 'active' : ''}`,
            'data-testid': 'view-memory',
            role: 'tab',
            onclick: () => void this.switchView('memory'),
          },
          '记忆',
        ),
        h(
          'button',
          {
            class: `tab ${this.view === 'maintenance' ? 'active' : ''}`,
            'data-testid': 'view-maintenance',
            role: 'tab',
            onclick: () => void this.switchView('maintenance'),
          },
          icon('chart'),
          '维护',
        ),
      ),
      ...(lib
        ? [
            h(
              'button',
              {
                class: 'btn',
                'data-testid': 'passphrase-btn',
                title: '口令管理（加密 / 轮换 / 解密回退）',
                onclick: () =>
                  void passphraseManage({
                    name: lib.name,
                    encrypted: lib.encrypted,
                    unlocked: lib.open?.encryptedUnlocked ?? false,
                  }).then(() => this.refresh()),
              },
              icon('lock'),
              '口令',
            ),
            h(
              'button',
              {
                class: 'btn',
                'data-testid': 'lock-btn',
                title: '锁库（清除内存口令）',
                onclick: () => void this.lockActive(),
              },
              '锁库',
            ),
          ]
        : []),
      h('button', { class: 'btn', 'data-testid': 'refresh-btn', onclick: () => void this.refresh() }, '刷新'),
    )
    this.refs.topbar = root
  }

  async switchView(view: ViewName): Promise<void> {
    this.view = view
    this.renderTopbar()
    this.renderContent()
  }

  private renderContent(): void {
    const root = document.querySelector<HTMLElement>('.content')
    if (!root) return
    clear(root)
    root.setAttribute('data-view', this.view)
    if (this.view === 'memory') {
      renderMemoryView(this, root)
    } else {
      void renderMaintenanceView(this, root)
    }
    this.refs.content = root
  }

  /** 列表/详情/筛选行局部重绘（不动工具栏——保持检索输入焦点） */
  private renderContentParts(): void {
    if (this.view !== 'memory') {
      this.renderContent()
      return
    }
    const content = document.querySelector<HTMLElement>('.content')
    if (content === null) {
      this.renderContent()
      return
    }
    let facetsRow = content.querySelector<HTMLElement>('.facets-row')
    if (facetsRow === null) {
      facetsRow = h('div', { class: 'facets-row' })
      content.prepend(facetsRow)
    }
    // 重新渲染筛选行 + 列表 + 详情（复用 renderMemoryView 的子渲染）
    const memoryView = content.querySelector<HTMLElement>('.split')
    if (memoryView) {
      const listPane = memoryView.querySelector<HTMLElement>('.list-pane')
      const detailPane = memoryView.querySelector<HTMLElement>('.detail-pane')
      if (listPane) renderList(this, listPane)
      if (detailPane) renderDetail(this, detailPane)
      this.refs.listPane = listPane ?? undefined
      this.refs.detailPane = detailPane ?? undefined
    }
    // 筛选行重绘（标签/工作区 chips）
    clear(facetsRow)
    const list = this.list
    if (list && !list.searched) {
      const state = this.listState
      const chips = [
        ...list.facets.byWorkspace.slice(0, 6).map(({ workspace, count }) =>
          h(
            'button',
            {
              class: `chip ${state.workspace === workspace ? 'active' : ''}`,
              onclick: () => void this.setFilter({ workspace: state.workspace === workspace ? undefined : workspace }),
            },
            `▣ ${workspace} ${count}`,
          ),
        ),
        ...list.facets.byTag.slice(0, 14).map(({ tag, count }) =>
          h(
            'button',
            {
              class: `chip ${state.tag === tag ? 'active' : ''}`,
              onclick: () => void this.setFilter({ tag: state.tag === tag ? undefined : tag }),
            },
            `${tag} ${count}`,
          ),
        ),
      ]
      facetsRow.append(...chips)
    }
  }

  async runImport(): Promise<void> {
    const r = await importWizard()
    if (r) {
      toast(`导入完成：新入库 ${r.imported} 条`)
      await this.refresh()
    }
  }
}
