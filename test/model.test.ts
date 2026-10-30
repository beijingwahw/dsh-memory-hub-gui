/**
 * 渲染层纯模型测试：标签解析 / 协议徽标折叠 / 摘要 / why 溯源文案
 */
import { describe, expect, it } from 'vitest'
import {
  parseTags,
  userTags,
  supersededBy,
  supersedes,
  conflictsWith,
  summarizeEntry,
  scoreBar,
  whyText,
  kindLabel,
  sourceLabel,
} from '../src/renderer/model'
import type { MemoryEntry, MemoryHit } from '../src/shared/protocol'

const entry = (over: Partial<MemoryEntry>): MemoryEntry => ({
  id: 'abc123-00000001',
  kind: 'fact',
  content: '样例内容',
  tags: [],
  source: 'explicit',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  accessCount: 0,
  ...over,
})

describe('parseTags', () => {
  it('中英文分隔符混合解析 + 去重保序', () => {
    expect(parseTags('构建, 项目X；部署 计划，构建')).toEqual(['构建', '项目X', '部署', '计划'])
    expect(parseTags('  ')).toEqual([])
    expect(parseTags('a,,b')).toEqual(['a', 'b'])
  })
})

describe('协议徽标折叠', () => {
  it('取代/矛盾前缀不进用户标签', () => {
    const e = entry({
      tags: ['ui', 'superseded-by:newid', 'supersede:oldid', 'conflicts-with:peer', 'conflict-of:peer2'],
    })
    expect(userTags(e)).toEqual(['ui'])
    expect(supersededBy(e)).toBe('newid')
    expect(supersedes(e)).toBe('oldid')
    expect(conflictsWith(e)).toEqual(['peer', 'peer2'])
  })
})

describe('summarizeEntry', () => {
  it('空白折叠 + 超长省略号', () => {
    expect(summarizeEntry(entry({ content: '第一行\n\n第二行   多空格' }))).toBe('第一行 第二行 多空格')
    const long = 'x'.repeat(200)
    const s = summarizeEntry(entry({ content: long }), 50)
    expect(s.length).toBe(51)
    expect(s.endsWith('…')).toBe(true)
  })
})

describe('scoreBar / whyText', () => {
  it('评分条按最高分归一 + 下限', () => {
    const hit = { ...entry({}), score: 0.5 } as MemoryHit
    expect(scoreBar(hit, 1)).toBe(0.5)
    expect(scoreBar({ ...hit, score: 0.0001 }, 1)).toBe(0.04)
    expect(scoreBar(hit, 0)).toBe(0)
  })

  it('why 文案含召回线中文名与融合模式', () => {
    const hit = {
      ...entry({}),
      score: 1.2,
      why: {
        fusion: 'rrf',
        lines: [
          { line: 'bm25', value: 0.02 },
          { line: 'graph', value: 0.01 },
        ],
        lineBase: 0.8,
        score: 1.2,
      },
    } as MemoryHit
    const text = whyText(hit)
    expect(text).toContain('词面 0.02')
    expect(text).toContain('图谱 0.01')
    expect(text).toContain('rrf')
  })
})

describe('标签映射', () => {
  it('kind / source 中文标签全覆盖', () => {
    expect(kindLabel('decision')).toBe('决策')
    expect(kindLabel('instruction')).toBe('指令')
    expect(sourceLabel('auto')).toBe('自动捕获')
    expect(sourceLabel('explicit')).toBe('显式记忆')
  })
})
