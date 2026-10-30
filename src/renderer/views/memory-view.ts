/**
 * 记忆视图：检索框 + 筛选（类型/来源/标签/工作区）+ 列表 + 详情面板
 *
 * 检索走主进程 engine.recall（六线融合，可展开 why 溯源）；
 * 列表默认按 updatedAt 倒序，检索时按评分降序。
 */
import { h, clear, fmtRelative, fmtDate, icon } from '../dom'
import {
  kindLabel,
  sourceLabel,
  summarizeEntry,
  scoreBar,
  whyText,
  userTags,
  supersededBy,
  supersedes,
  conflictsWith,
} from '../model'
import { api, ApiError } from '../api'
import { editorModal, confirmModal, toast } from './modals'
import type { ListItemHit, ListParams, ListResult, MemoryEntry, MemoryKind, MemorySource } from '../../shared/protocol'
import type { App } from '../app'

const KIND_FILTERS: Array<{ value: MemoryKind; label: string }> = [
  { value: 'decision', label: '决策' },
  { value: 'fact', label: '事实' },
  { value: 'preference', label: '偏好' },
  { value: 'instruction', label: '指令' },
  { value: 'generic', label: '通用' },
]

export async function runCreateEntry(app: App, prefillWorkspace?: string): Promise<void> {
  const r = await editorModal({ mode: 'create', defaultWorkspace: prefillWorkspace }).catch(() => undefined)
  if (r === undefined) return
  try {
    const entry = await api.entryCreate({
      content: r.content,
      kind: r.kind,
      tags: r.tags,
      workspace: r.workspace || undefined,
    })
    toast(`已保存记忆 ${entry.id.slice(0, 12)}…（${kindLabel(entry.kind)}）`)
    await app.refresh()
    app.select(entry.id)
  } catch (e) {
    toast(errText(e), 'error')
  }
}

export async function runEditEntry(app: App, entry: MemoryEntry): Promise<void> {
  const r = await editorModal({ mode: 'edit', entry }).catch(() => undefined)
  if (r === undefined) return
  try {
    const updated = await api.entryUpdate({
      id: entry.id,
      content: r.content,
      kind: r.kind,
      tags: r.tags,
      workspace: r.workspace || null,
    })
    toast('已保存编辑（append-only 版本推进，深回放历史保留）')
    await app.refresh()
    app.select(updated.id)
  } catch (e) {
    toast(errText(e), 'error')
  }
}

export async function runSupersedeEntry(app: App, entry: MemoryEntry): Promise<void> {
  const r = await editorModal({ mode: 'supersede', entry }).catch(() => undefined)
  if (r === undefined) return
  try {
    const { newEntry } = await api.entrySupersede({ id: entry.id, content: r.content, kind: r.kind, tags: r.tags })
    toast(`新版本 ${newEntry.id.slice(0, 12)}… 已写入；旧记忆标记被取代（召回降权）`)
    await app.refresh()
    app.select(newEntry.id)
  } catch (e) {
    toast(errText(e), 'error')
  }
}

export async function runDeleteEntries(app: App, ids: string[]): Promise<void> {
  if (ids.length === 1) {
    const ok = await confirmModal(
      '删除记忆',
      '软删除（tombstone）：条目立即从召回中消失，时间轴保留删除事件；情景回放可追溯。',
      '删除',
    )
    if (!ok) return
  } else {
    const ok = await confirmModal(`删除 ${ids.length} 条记忆`, '批量软删除（tombstone）。', '全部删除')
    if (!ok) return
  }
  try {
    const n = await api.entryDelete(ids)
    toast(`已删除 ${n} 条（tombstone 落盘）`)
    app.select(undefined)
    await app.refresh()
  } catch (e) {
    toast(errText(e), 'error')
  }
}

export function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const zh: Record<string, string> = {
      NEEDS_PASSPHRASE: '该库已加密，需要口令',
      WRONG_PASSPHRASE: '口令错误或库被篡改',
      EMPTY_CONTENT: '内容不能为空',
      SENSITIVE_CONTENT: '内容疑似含敏感明文（密钥/口令/令牌），已拒绝——与插件同一防线',
      NOT_FOUND: '条目不存在（可能已被删除）',
      NO_ACTIVE_LIBRARY: '没有打开的记忆库',
      DEFAULT_IMMUTABLE: '默认库不可移除',
      DUPLICATE_LIBRARY: '该库已在列表中',
      INVALID_PAYLOAD: '请求参数不合法',
    }
    return zh[e.code] ?? e.message
  }
  return e instanceof Error ? e.message : String(e)
}

export function renderMemoryView(app: App, container: HTMLElement): void {
  clear(container)
  const state = app.listState

  /* ------------------------------- 工具栏 ------------------------------- */
  const searchInput = h('input', {
    class: 'input search',
    type: 'search',
    placeholder: '检索记忆（六线融合：词面 / 容错 / 语义 / 图谱 / 推理 / 向量）…',
    'data-testid': 'search-input',
  }) as HTMLInputElement
  searchInput.value = state.query ?? ''
  let searchDebounce: ReturnType<typeof setTimeout> | undefined
  searchInput.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce)
    searchDebounce = setTimeout(() => {
      void app.setQuery(searchInput.value)
    }, 220)
  })

  const kindSelect = h('select', { class: 'input filter', 'data-testid': 'filter-kind' }) as HTMLSelectElement
  kindSelect.append(h('option', { value: '' }, '全部类型') as HTMLOptionElement)
  for (const k of KIND_FILTERS) {
    const o = h('option', { value: k.value }, k.label) as HTMLOptionElement
    if (state.kind === k.value) o.selected = true
    kindSelect.append(o)
  }
  kindSelect.addEventListener(
    'change',
    () => void app.setFilter({ kind: (kindSelect.value || undefined) as MemoryKind | undefined }),
  )

  const sourceSelect = h('select', { class: 'input filter' }) as HTMLSelectElement
  sourceSelect.append(h('option', { value: '' }, '全部来源') as HTMLOptionElement)
  for (const [value, label] of [
    ['explicit', '显式记忆'],
    ['auto', '自动捕获'],
  ] as Array<[MemorySource, string]>) {
    const o = h('option', { value: label }) as HTMLOptionElement
    o.value = value
    o.textContent = label
    if (state.source === value) o.selected = true
    sourceSelect.append(o)
  }
  sourceSelect.addEventListener(
    'change',
    () => void app.setFilter({ source: (sourceSelect.value || undefined) as MemorySource | undefined }),
  )

  const sortSelect = h('select', { class: 'input filter' }) as HTMLSelectElement
  for (const [value, label] of [
    ['updated', '最近更新'],
    ['created', '最近创建'],
    ['heat', '访问热度'],
  ] as const) {
    const o = h('option', { value: label }) as HTMLOptionElement
    o.value = value
    o.textContent = label
    if ((state.sort ?? 'updated') === value) o.selected = true
    sortSelect.append(o)
  }
  sortSelect.addEventListener('change', () => void app.setSort(sortSelect.value as 'updated' | 'created' | 'heat'))

  const newBtn = h('button', { class: 'btn primary', 'data-testid': 'new-entry' }, icon('plus'), '新建记忆')
  newBtn.addEventListener('click', () => void runCreateEntry(app))

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    searchInput,
    kindSelect,
    sourceSelect,
    sortSelect,
    h('div', { class: 'spacer' }),
    newBtn,
  )

  /* ------------------------------- 筛选标签行 ------------------------------- */
  const facetsRow = h('div', { class: 'facets-row', 'data-testid': 'facets' })
  const list = app.list
  if (list && !list.searched) {
    const tagChips = list.facets.byTag.slice(0, 14).map(({ tag, count }) =>
      h(
        'button',
        {
          class: `chip ${state.tag === tag ? 'active' : ''}`,
          onclick: () => void app.setFilter({ tag: state.tag === tag ? undefined : tag }),
        },
        `${tag} ${count}`,
      ),
    )
    const wsChips = list.facets.byWorkspace.slice(0, 6).map(({ workspace, count }) =>
      h(
        'button',
        {
          class: `chip ${state.workspace === workspace ? 'active' : ''}`,
          onclick: () => void app.setFilter({ workspace: state.workspace === workspace ? undefined : workspace }),
        },
        `▣ ${workspace} ${count}`,
      ),
    )
    const activeChips: HTMLElement[] = []
    if (state.tag) activeChips.push(h('span', { class: 'chip active static' }, `标签：${state.tag}`))
    if (state.workspace) activeChips.push(h('span', { class: 'chip active static' }, `工作区：${state.workspace}`))
    if (activeChips.length || tagChips.length || wsChips.length) {
      facetsRow.append(...activeChips, ...wsChips, ...tagChips)
    }
  }

  /* ------------------------------- 列表 + 详情 ------------------------------- */
  const listPane = h('div', { class: 'list-pane', 'data-testid': 'entry-list' })
  const detailPane = h('aside', { class: 'detail-pane', 'data-testid': 'detail-pane' })
  renderList(app, listPane)
  renderDetail(app, detailPane)

  container.append(toolbar, facetsRow, h('div', { class: 'split' }, listPane, detailPane))
}

export function renderList(app: App, listPane: HTMLElement): void {
  clear(listPane)
  const list = app.list
  if (list === undefined) {
    listPane.append(h('div', { class: 'empty' }, '加载中…'))
    return
  }
  if (list.items.length === 0) {
    listPane.append(
      h(
        'div',
        { class: 'empty' },
        list.searched
          ? '没有匹配的记忆——试试更短的关键词（容错/语义线会兜底近似表达）。'
          : '当前库还没有记忆：点右上「新建记忆」，或从工具栏「导入」批量入库。',
      ),
    )
    return
  }
  const maxScore = list.searched ? Math.max(...list.items.map((x) => x.score ?? 0), 1e-9) : 0
  const listEl = h('ul', { class: 'entry-list' })
  for (const hit of list.items) {
    const selected = app.selectedId === hit.id
    const item = h(
      'li',
      {
        class: `entry-item ${selected ? 'selected' : ''}`,
        'data-entry-id': hit.id,
        onclick: () => app.select(hit.id),
      },
      h(
        'div',
        { class: 'entry-line' },
        h('span', { class: `kind-badge k-${hit.kind}` }, kindLabel(hit.kind)),
        h('span', { class: 'entry-summary' }, summarizeEntry(hit)),
        ...(supersededBy(hit) ? [h('span', { class: 'badge superseded' }, '已被取代')] : []),
        ...(conflictsWith(hit).length > 0 ? [h('span', { class: 'badge conflict' }, '矛盾共存')] : []),
      ),
      h(
        'div',
        { class: 'entry-meta' },
        h(
          'span',
          { class: 'meta-dim' },
          `${sourceLabel(hit.source)} · ${fmtRelative(hit.updatedAt)} · 热度 ${hit.accessCount}`,
        ),
        ...(hit.workspace ? [h('span', { class: 'meta-ws' }, `▣ ${hit.workspace}`)] : []),
        ...userTags(hit)
          .slice(0, 3)
          .map((t) => h('span', { class: 'mini-tag' }, t)),
      ),
      ...(list.searched
        ? [
            h(
              'div',
              { class: 'score-row' },
              h(
                'div',
                { class: 'score-bar' },
                h('div', { class: 'score-fill', style: `width:${Math.round(scoreBar(hit, maxScore) * 100)}%` }),
              ),
              h('span', { class: 'score-num' }, (hit.score ?? 0).toFixed(3)),
            ),
          ]
        : []),
    )
    listEl.append(item)
  }
  listPane.append(listEl)
  const shown = list.offset + list.items.length
  if (shown < list.total) {
    const more = h(
      'button',
      { class: 'btn load-more', 'data-testid': 'load-more' },
      `加载更多（${shown}/${list.total}）`,
    )
    more.addEventListener('click', () => void app.loadMore())
    listPane.append(more)
  } else {
    listPane.append(h('div', { class: 'list-count' }, `${list.total} 条${list.searched ? ' 命中' : ''}`))
  }
}

export function renderDetail(app: App, detailPane: HTMLElement): void {
  clear(detailPane)
  const selected = app.selected
  if (selected === undefined) {
    detailPane.append(h('div', { class: 'empty' }, '选择一条记忆查看详情'))
    return
  }
  const hit = app.list?.items.find((x) => x.id === selected.id)
  const rows: Array<[string, string]> = [
    ['id', selected.id],
    ['类型', kindLabel(selected.kind)],
    ['来源', sourceLabel(selected.source)],
    ['创建', fmtDate(selected.createdAt)],
    ['更新', fmtDate(selected.updatedAt)],
    [
      '热度',
      `${selected.accessCount} 次召回${selected.lastAccessAt ? ` · 最近 ${fmtRelative(selected.lastAccessAt)}` : ''}`,
    ],
    ...(selected.workspace ? ([['工作区', selected.workspace]] as Array<[string, string]>) : []),
    ...(selected.sessionId ? ([['来源会话', selected.sessionId]] as Array<[string, string]>) : []),
  ]
  const supersededById = supersededBy(selected)
  const supersedesId = supersedes(selected)
  const peers = conflictsWith(selected)

  const meta = h('dl', { class: 'meta-list' })
  for (const [k, v] of rows) {
    meta.append(h('dt', {}, k), h('dd', {}, v))
  }
  if (supersededById) meta.append(h('dt', {}, '被取代于'), h('dd', {}, supersededById))
  if (supersedesId) meta.append(h('dt', {}, '取代了'), h('dd', {}, supersedesId))
  if (peers.length) meta.append(h('dt', {}, '矛盾标注'), h('dd', {}, peers.join(' · ')))

  const content = h('pre', { class: 'detail-content' }, selected.content)
  const tagsRow = h(
    'div',
    { class: 'tag-row' },
    ...userTags(selected).map((t) => h('span', { class: 'chip static' }, t)),
  )

  const actions = h(
    'div',
    { class: 'detail-actions' },
    h(
      'button',
      { class: 'btn', 'data-testid': 'detail-edit', onclick: () => void runEditEntry(app, selected) },
      icon('edit'),
      '编辑',
    ),
    h(
      'button',
      { class: 'btn', 'data-testid': 'detail-supersede', onclick: () => void runSupersedeEntry(app, selected) },
      icon('replace'),
      '取代',
    ),
    h(
      'button',
      { class: 'btn danger', 'data-testid': 'detail-delete', onclick: () => void runDeleteEntries(app, [selected.id]) },
      icon('trash'),
      '删除',
    ),
  )

  const why =
    hit?.why !== undefined && hit.why !== null
      ? h(
          'div',
          { class: 'why-box' },
          h('div', { class: 'why-title' }, '召回溯源 why'),
          h('div', { class: 'why-text' }, whyText(hit)),
        )
      : undefined

  detailPane.append(
    h('div', { class: `detail-kind k-${selected.kind}` }, kindLabel(selected.kind)),
    content,
    tagsRow,
    meta,
    ...(why ? [why] : []),
    actions,
  )
}

export type { ListParams, ListResult, ListItemHit }
