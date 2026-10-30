/**
 * 安全 DOM 助手：全部文本经 textContent 注入（零 innerHTML 用户数据拼接），
 * 与插件 1.5.1 可视化检索页同一注入纪律。
 */

export type Child = Node | string | null | undefined | false

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | boolean | undefined | ((e: Event) => void)> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === false) continue
      if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2), value as EventListener)
      } else if (key === 'class') el.className = String(value)
      else if (key === 'dataset' && typeof value === 'object') {
        /* not used */
      } else if (value === true) el.setAttribute(key, '')
      else el.setAttribute(key, String(value))
    }
  }
  append(el, children)
  return el
}

export function append(el: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    el.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild)
}

export function icon(
  name:
    | 'lock'
    | 'lock-open'
    | 'plus'
    | 'trash'
    | 'edit'
    | 'search'
    | 'download'
    | 'upload'
    | 'chart'
    | 'library'
    | 'link'
    | 'replace'
    | 'close',
): HTMLElement {
  const glyphs: Record<string, string> = {
    lock: '🔒',
    'lock-open': '🔓',
    plus: '＋',
    trash: '🗑',
    edit: '✎',
    search: '⌕',
    download: '⤓',
    upload: '⤒',
    chart: '▤',
    library: '🗃',
    link: '⛓',
    replace: '⇄',
    close: '✕',
  }
  const span = h('span', { class: 'icon', 'aria-hidden': 'true' })
  span.textContent = glyphs[name] ?? ''
  return span
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function fmtDate(ts: number | undefined): string {
  if (ts === undefined) return '—'
  const d = new Date(ts)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtRelative(ts: number | undefined, now = Date.now()): string {
  if (ts === undefined) return '—'
  const diff = now - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return fmtDate(ts)
}
