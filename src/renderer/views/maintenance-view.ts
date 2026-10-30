/**
 * 维护视图：统计卡片 / 类型分布 / 主题聚类 / 记忆时间轴 / 存储诊断
 */
import { h, clear, fmtBytes, fmtDate, icon } from '../dom'
import { kindLabel } from '../model'
import { timelineTooltip } from '../model'
import type { App } from '../app'
import type { MemoryKind, MemoryStats, MemoryTimeline, ThemeCluster } from '../../shared/protocol'
import { statCard } from './modals'

const KIND_ORDER: MemoryKind[] = ['decision', 'fact', 'preference', 'instruction', 'generic']

export async function renderMaintenanceView(app: App, container: HTMLElement): Promise<void> {
  clear(container)
  container.append(h('div', { class: 'empty' }, '统计加载中…'))
  let status
  try {
    status = await app.loadStatus()
  } catch {
    clear(container)
    container.append(h('div', { class: 'empty' }, '无法读取维护统计（请先打开一个库）'))
    return
  }
  clear(container)

  const s: MemoryStats = status.stats
  const total = Math.max(1, s.total)

  /* ------------------------------- 统计卡片 ------------------------------- */
  const cards = h(
    'div',
    { class: 'stats-grid', 'data-testid': 'stats-grid' },
    statCard('记忆总数', String(s.total), 'primary'),
    statCard('库体量', fmtBytes(s.bytes)),
    statCard('日志行数', String(status.diagnostics.lines)),
    statCard('被取代', String(s.superseded ?? 0)),
    statCard('主题聚类', String(status.themes.length)),
    statCard('损坏行隔离', String(status.diagnostics.skippedCorrupt)),
    statCard('加密', status.encrypted ? (status.unlocked ? '已加密·解锁' : '已加密') : '明文'),
    statCard('结构版本', String(status.diagnostics.revision)),
  )

  /* ------------------------------- 类型分布 ------------------------------- */
  const kindBars = h('div', { class: 'panel' }, h('h4', {}, '类型分布'))
  const byKind = h('div', { class: 'bar-rows' })
  for (const k of KIND_ORDER) {
    const n = s.byKind[k] ?? 0
    byKind.append(
      h(
        'div',
        { class: 'bar-row' },
        h('span', { class: `kind-badge k-${k}` }, kindLabel(k)),
        h(
          'div',
          { class: 'bar-track' },
          h('div', { class: `bar-fill k-${k}`, style: `width:${Math.round((100 * n) / total)}%` }),
        ),
        h('span', { class: 'bar-num' }, String(n)),
      ),
    )
  }
  kindBars.append(byKind)

  const sourcePanel = h('div', { class: 'panel' }, h('h4', {}, '来源构成'))
  const bySource = h('div', { class: 'bar-rows' })
  for (const [key, label] of [
    ['explicit', '显式记忆'],
    ['auto', '自动捕获'],
  ] as const) {
    const n = s.bySource[key] ?? 0
    bySource.append(
      h(
        'div',
        { class: 'bar-row' },
        h('span', { class: 'bar-label' }, label),
        h(
          'div',
          { class: 'bar-track' },
          h('div', { class: 'bar-fill src', style: `width:${Math.round((100 * n) / total)}%` }),
        ),
        h('span', { class: 'bar-num' }, String(n)),
      ),
    )
  }
  sourcePanel.append(bySource)

  /* ------------------------------- 主题聚类 ------------------------------- */
  const themesPanel = h('div', { class: 'panel' }, h('h4', {}, '主题聚类（共享标签 ≥2 的记忆群）'))
  const themes: ThemeCluster[] = status.themes
  if (themes.length === 0) {
    themesPanel.append(h('p', { class: 'hint' }, '暂无主题聚类——标签用得越多，聚类越准。'))
  } else {
    const themeList = h('div', { class: 'theme-list' })
    for (const t of themes.slice(0, 20)) {
      themeList.append(
        h(
          'div',
          { class: 'theme-item', title: t.label },
          h('span', { class: 'chip static' }, t.label),
          h('span', { class: 'meta-dim' }, `${t.memberCount} 条`),
        ),
      )
    }
    themesPanel.append(themeList)
  }

  /* ------------------------------- 时间轴 ------------------------------- */
  const tlPanel = h('div', { class: 'panel wide' }, h('h4', {}, '记忆时间轴（近 90 天事件流）'))
  tlPanel.append(renderTimeline(status.timeline))

  /* ------------------------------- 存储诊断 ------------------------------- */
  const diag = h('div', { class: 'panel wide', 'data-testid': 'diagnostics' }, h('h4', {}, '存储诊断'))
  const diagList = h('dl', { class: 'meta-list' })
  diagList.append(
    h('dt', {}, '库文件'),
    h('dd', {}, status.filePath),
    h('dt', {}, '最早记忆'),
    h('dd', {}, s.oldestAt !== undefined ? fmtDate(s.oldestAt) : '—'),
    h('dt', {}, '最新记忆'),
    h('dd', {}, s.newestAt !== undefined ? fmtDate(s.newestAt) : '—'),
    h('dt', {}, '时间轴事件'),
    h(
      'dd',
      {},
      `${status.timeline.events} 个（首 ${fmtDate(status.timeline.firstAt || undefined)} → 末 ${fmtDate(status.timeline.lastAt || undefined)}）${status.timeline.truncated ? ' · 已截断至最近 90 桶' : ''}`,
    ),
    h('dt', {}, '最近 compact'),
    h(
      'dd',
      {},
      status.diagnostics.compact.atLineCount > 0
        ? `${fmtDate(status.diagnostics.compact.atLineCount)} 行时回收 ${fmtBytes(status.diagnostics.compact.reclaimed)}（压缩比 ${status.diagnostics.compact.ratio.toFixed(2)}）`
        : '尚未触发（COMPACT_FACTOR=2 / ≥64 行）',
    ),
  )
  diag.append(diagList)

  container.append(
    h('h3', { class: 'view-title' }, icon('chart'), ' 库维护'),
    cards,
    h('div', { class: 'panel-grid' }, kindBars, sourcePanel),
    themesPanel,
    tlPanel,
    diag,
  )
}

export function renderTimeline(timeline: MemoryTimeline): HTMLElement {
  const buckets = timeline.buckets
  if (buckets.length === 0) {
    return h('p', { class: 'hint' }, '（无时间锚事件——空库或全部历史已被 compact 重建）')
  }
  const maxEvents = Math.max(1, ...buckets.map((b) => b.added + b.removed + b.updated + b.heat))
  const wrap = h('div', { class: 'timeline', 'data-testid': 'timeline' })
  const cols = h('div', { class: 'timeline-cols' })
  buckets.forEach((b, i) => {
    const total = b.added + b.removed + b.updated + b.heat
    const height = Math.max(3, Math.round((100 * total) / maxEvents))
    const bar = h('div', { class: 'tl-bar', style: `height:${height}%`, title: timelineTooltip(b) })
    const seg = (n: number, cls: string): void => {
      if (n > 0) bar.append(h('i', { class: cls, style: `flex:${n}` }))
    }
    seg(b.added, 'a')
    seg(b.updated, 'u')
    seg(b.heat, 'h')
    seg(b.removed, 'r')
    const label = i === 0 || i === buckets.length - 1 || i % 10 === 9 ? b.day.slice(5) : ''
    cols.append(h('div', { class: 'tl-col', title: timelineTooltip(b) }, bar, h('span', { class: 'tl-day' }, label)))
  })
  wrap.append(
    cols,
    h(
      'div',
      { class: 'legend' },
      h('span', {}, h('i', { class: 'dot a' }), '新增'),
      h('span', {}, h('i', { class: 'dot u' }), '更新'),
      h('span', {}, h('i', { class: 'dot h' }), '热度'),
      h('span', {}, h('i', { class: 'dot r' }), '删除'),
    ),
  )
  return wrap
}
