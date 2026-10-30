/**
 * 渲染层纯模型：标签解析 / 类型标签 / 摘要折叠 / 排序描述
 * （零 DOM 依赖，vitest 直接测试；视图层保持薄）
 */
import type { ListItemHit, MemoryEntry, MemoryKind, MemorySource } from '../shared/protocol'

/* 取代/矛盾协议 tag 前缀——与 entry-factory / conflict 常量同值镜像
   （渲染层不 import dsh-memory-hub/core：core 含 node:crypto，浏览器端不可打包） */
const SUPERSEDED_BY_TAG_PREFIX = 'superseded-by:'
const SUPERSEDE_TAG_PREFIX = 'supersede:'
const CONFLICT_OF_TAG_PREFIX = 'conflict-of:'
const CONFLICTS_WITH_TAG_PREFIX = 'conflicts-with:'

export const KIND_LABELS: Record<MemoryKind, string> = {
  decision: '决策',
  fact: '事实',
  preference: '偏好',
  instruction: '指令',
  generic: '通用',
}

export const SOURCE_LABELS: Record<MemorySource, string> = {
  auto: '自动捕获',
  explicit: '显式记忆',
}

export function kindLabel(kind: MemoryKind): string {
  return KIND_LABELS[kind] ?? kind
}

export function sourceLabel(source: MemorySource): string {
  return SOURCE_LABELS[source] ?? source
}

/** 标签输入解析：逗号 / 中文逗号 / 分号 / 空白 分隔，trim + 去空 + 去重（保序） */
export function parseTags(input: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of input.split(/[,，;；\s]+/)) {
    const t = raw.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/** 用户可见标签（协议 tag 前缀折叠为徽标，不再作为普通标签展示） */
export function userTags(entry: Pick<MemoryEntry, 'tags'>): string[] {
  return entry.tags.filter(
    (t) =>
      !t.startsWith(SUPERSEDED_BY_TAG_PREFIX) &&
      !t.startsWith(SUPERSEDE_TAG_PREFIX) &&
      !t.startsWith(CONFLICT_OF_TAG_PREFIX) &&
      !t.startsWith(CONFLICTS_WITH_TAG_PREFIX),
  )
}

export function supersededBy(entry: Pick<MemoryEntry, 'tags'>): string | undefined {
  return entry.tags.find((t) => t.startsWith(SUPERSEDED_BY_TAG_PREFIX))?.slice(SUPERSEDED_BY_TAG_PREFIX.length)
}

export function supersedes(entry: Pick<MemoryEntry, 'tags'>): string | undefined {
  return entry.tags.find((t) => t.startsWith(SUPERSEDE_TAG_PREFIX))?.slice(SUPERSEDE_TAG_PREFIX.length)
}

export function conflictsWith(entry: Pick<MemoryEntry, 'tags'>): string[] {
  const explicit = entry.tags
    .filter((t) => t.startsWith(CONFLICTS_WITH_TAG_PREFIX))
    .map((t) => t.slice(CONFLICTS_WITH_TAG_PREFIX.length))
  const reverse = entry.tags
    .filter((t) => t.startsWith(CONFLICT_OF_TAG_PREFIX))
    .map((t) => t.slice(CONFLICT_OF_TAG_PREFIX.length))
  return [...explicit, ...reverse]
}

/** 列表行摘要：单行折叠 + 最多 n 个标签 */
export function summarizeEntry(entry: Pick<MemoryEntry, 'content'>, maxLen = 140): string {
  const oneLine = entry.content.replace(/\s+/g, ' ').trim()
  return oneLine.length <= maxLen ? oneLine : `${oneLine.slice(0, maxLen)}…`
}

/** 检索命中评分 → 0..1 相对强度（用于分数条；首轮结果按最高分归一） */
export function scoreBar(hit: Pick<ListItemHit, 'score'>, maxScore: number): number {
  const score = hit.score ?? 0
  if (maxScore <= 0 || score <= 0) return 0
  return Math.max(0.04, Math.min(1, score / maxScore))
}

export const WHY_LINE_LABELS: Record<string, string> = {
  bm25: '词面',
  fuzzy: '容错',
  semantic: '语义',
  graph: '图谱',
  infer: '推理',
  vector: '向量',
}

/** 召回溯源 → 人话（「词面 0.42 + 语义 0.13 · 融合 interpolate」） */
export function whyText(hit: ListItemHit): string {
  const why = hit.why
  if (why === undefined) return ''
  const lines = why.lines.map((l) => `${WHY_LINE_LABELS[l.line] ?? l.line} ${l.value.toFixed(2)}`).join(' + ')
  return `${lines || '基准分'} · 融合 ${why.fusion} · 公共因子 ${why.lineBase.toFixed(2)}`
}

/** 时间轴桶 → 本地日期（yyyy-mm-dd，与后端 UTC 日对齐展示原值） */
export function timelineTooltip(bucket: {
  day: string
  added: number
  removed: number
  updated: number
  heat: number
  total: number
}): string {
  return `${bucket.day}：新增 ${bucket.added} · 删除 ${bucket.removed} · 更新 ${bucket.updated} · 热度 ${bucket.heat} → 存活 ${bucket.total}`
}
