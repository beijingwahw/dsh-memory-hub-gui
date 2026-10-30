/**
 * 应用图标生成：纯 Node PNG 编码（zlib + 手写 IHDR/IDAT/IEND），零图像依赖
 *
 * 设计：深色圆角方形 + 三段「记忆层叠」条（与 GUI 品牌色一致）。
 * 确定性：同一脚本逐字节可复算。
 */
import { deflateSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 512
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'build', 'icon.png')

/* ------------------------------ CRC32（PNG 标准） ------------------------------ */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/* ------------------------------ 像素绘制 ------------------------------ */

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t)
}

function mix(bg, fg, alpha) {
  return [lerp(bg[0], fg[0], alpha), lerp(bg[1], fg[1], alpha), lerp(bg[2], fg[2], alpha), 255]
}

/** 圆角方形覆盖度（0..1，2px 抗锯齿带） */
function roundedRectCoverage(x, y, size, radius) {
  const rx = Math.min(x, size - 1 - x)
  const ry = Math.min(y, size - 1 - y)
  if (rx >= radius + 1 && ry >= radius + 1) return 1
  if (rx >= radius || ry >= radius) {
    // 圆角带：距角圆心的有符号距离
    const dx = radius - rx
    const dy = radius - ry
    const d = Math.sqrt(dx * dx + dy * dy) - radius
    if (d <= -1.5) return 1
    if (d >= 1.5) return 0
    return 0.5 - d / 3
  }
  const dx = radius - rx
  const dy = radius - ry
  const d = Math.sqrt(dx * dx + dy * dy) - radius
  return d <= -1.5 ? 1 : d >= 1.5 ? 0 : 0.5 - d / 3
}

/** 水平圆角条的覆盖度 */
function barCoverage(x, y, x0, x1, y0, y1, radius) {
  if (x < x0 - 1 || x > x1 + 1 || y < y0 - 1 || y > y1 + 1) return 0
  const cx = Math.min(Math.max(x, x0 + radius), x1 - radius)
  const cy = Math.min(Math.max(y, y0 + radius), y1 - radius)
  const d = Math.hypot(x - cx, y - cy) - radius
  if (y >= y0 + radius && y <= y1 - radius) return x >= x0 && x <= x1 ? 1 : 0
  if (d <= -1.5) return 1
  if (d >= 1.5) return 0
  return 0.5 - d / 3
}

const BARS = [
  { y0: 168, y1: 216, x0: 128, x1: 384, color: [124, 231, 135, 255] }, // 绿（事实）
  { y0: 236, y1: 284, x0: 152, x1: 384, color: [76, 141, 255, 255] }, // 蓝（检索）
  { y0: 304, y1: 352, x0: 176, x1: 384, color: [210, 168, 255, 255] }, // 紫（图谱）
]

function render() {
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4))
  const top = [13, 17, 23, 255]
  const bottom = [22, 27, 34, 255]
  const R = 108
  for (let y = 0; y < SIZE; y++) {
    raw[y * (1 + SIZE * 4)] = 0 // filter: None
    for (let x = 0; x < SIZE; x++) {
      const cover = roundedRectCoverage(x, y, SIZE, R)
      let px = mix([0, 0, 0, 0], mix(top, bottom, y / (SIZE - 1)), cover)
      for (const bar of BARS) {
        const b = barCoverage(x, y, bar.x0, bar.x1, bar.y0, bar.y1, 16)
        if (b > 0) px = mix(px, bar.color, b)
      }
      const o = y * (1 + SIZE * 4) + 1 + x * 4
      raw[o] = px[0]
      raw[o + 1] = px[1]
      raw[o + 2] = px[2]
      raw[o + 3] = px[3]
    }
  }
  return raw
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(render(), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

await mkdir(dirname(out), { recursive: true })
await writeFile(out, png)
console.log(`[icon] ${out} (${png.length} bytes, ${SIZE}×${SIZE})`)
