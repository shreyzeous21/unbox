#!/usr/bin/env node
/**
 * generate-icon.mjs — builds the Unbox app icon with zero dependencies.
 *
 * Renders at 1024×1024 with per-pixel signed-distance anti-aliasing:
 * rounded-square gradient base + white "open box with rising arrow" glyph,
 * then produces build/icon.png, the macOS .icns (via sips + iconutil), and
 * the renderer logo. Run: `npm run icons`.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = path.join(ROOT, 'build')
const SIZE = 1024

// ---------- minimal PNG encoder ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'binary'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePNG(rgba, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ---------- drawing helpers (SDF, smooth coverage) ----------
const clamp01 = (x) => Math.max(0, Math.min(1, x))
const smooth = (d) => clamp01(0.5 - d) // d in pixels, 0 at edge, +inside

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - hw + r
  const dy = Math.abs(py - cy) - hh + r
  const ox = Math.max(dx, 0)
  const oy = Math.max(dy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r
}

function sdTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const seg = (p0x, p0y, p1x, p1y) => {
    const ex = p1x - p0x
    const ey = p1y - p0y
    const wx = px - p0x
    const wy = py - p0y
    const t = clamp01((wx * ex + wy * ey) / (ex * ex + ey * ey || 1))
    const dx = wx - ex * t
    const dy = wy - ey * t
    return dx * dx + dy * dy
  }
  // inside test via edge cross products
  const cross = (p0x, p0y, p1x, p1y) => (p1x - p0x) * (py - p0y) - (p1y - p0y) * (px - p0x)
  const d1 = cross(ax, ay, bx, by)
  const d2 = cross(bx, by, cx, cy)
  const d3 = cross(cx, cy, ax, ay)
  const inside = (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)
  const dist = Math.sqrt(Math.min(seg(ax, ay, bx, by), seg(bx, by, cx, cy), seg(cx, cy, ax, ay)))
  return inside ? -dist : dist
}

/** alpha-blends src over dst (both [r,g,b,a] 0..1) */
function over(dst, src) {
  const a = src[3] + dst[3] * (1 - src[3])
  if (a <= 0) return [0, 0, 0, 0]
  for (let i = 0; i < 3; i++) {
    dst[i] = (src[i] * src[3] + dst[i] * dst[3] * (1 - src[3])) / a
  }
  dst[3] = a
  return dst
}

// ---------- render ----------
const rgba = Buffer.alloc(SIZE * SIZE * 4)

// Glyph geometry (1024 space)
const BOX = { cx: 512, cy: 655, hw: 252, hh: 118, r: 30 }
const SLOT_L = { x0: 292, x1: 452, y0: 596, y1: 626 }
const SLOT_R = { x0: 572, x1: 732, y0: 596, y1: 626 }
const ARROW_SHAFT = { cx: 512, cy: 445, hw: 42, hh: 175, r: 14 }
const ARROW_HEAD = { ax: 512, ay: 218, bx: 366, by: 392, cx: 658, by2: 392 }

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5
    const py = y + 0.5

    // Base: rounded square with a vertical azure→indigo gradient + soft top sheen.
    const R = 232
    const dBase = sdRoundRect(px, py, SIZE / 2, SIZE / 2, SIZE / 2 - 8, SIZE / 2 - 8, R)
    let col = [0, 0, 0, 0]
    if (dBase < 2) {
      const t = clamp01(py / SIZE)
      const top = [0.33, 0.65, 0.99] // #54A6FC
      const bot = [0.36, 0.33, 0.95] // #5C54F2
      const g = [top[0] + (bot[0] - top[0]) * t, top[1] + (bot[1] - top[1]) * t, top[2] + (bot[2] - top[2]) * t]
      // Soft top sheen for a glass feel.
      const sheen = clamp01(1 - py / (SIZE * 0.45)) * 0.10
      const base = [g[0] + sheen, g[1] + sheen, g[2] + sheen]
      const cov = smooth(dBase)
      col = [base[0], base[1], base[2], cov]
    }
    if (col[3] <= 0) {
      const i = (y * SIZE + x) * 4
      rgba[i] = 0
      rgba[i + 1] = 0
      rgba[i + 2] = 0
      rgba[i + 3] = 0
      continue
    }

    // White box body.
    const dBox = sdRoundRect(px, py, BOX.cx, BOX.cy, BOX.hw, BOX.hh, BOX.r)
    if (dBox < 1) over(col, [1, 1, 1, smooth(dBox) * 0.98])

    // Slot shading across the box opening (interrupted by the arrow).
    for (const s of [SLOT_L, SLOT_R]) {
      const dSlot = sdRoundRect(px, py, (s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, (s.x1 - s.x0) / 2, (s.y1 - s.y0) / 2, 10)
      if (dSlot < 1) over(col, [0.23, 0.32, 0.86, smooth(dSlot) * 0.4])
    }

    // Arrow shaft + head.
    const dShaft = sdRoundRect(px, py, ARROW_SHAFT.cx, ARROW_SHAFT.cy, ARROW_SHAFT.hw, ARROW_SHAFT.hh, ARROW_SHAFT.r)
    if (dShaft < 1) over(col, [1, 1, 1, smooth(dShaft) * 0.98])
    const dHead = sdTriangle(px, py, ARROW_HEAD.ax, ARROW_HEAD.ay, ARROW_HEAD.bx, ARROW_HEAD.by, ARROW_HEAD.cx, ARROW_HEAD.by2)
    if (dHead < 1) over(col, [1, 1, 1, smooth(dHead) * 0.98])

    const i = (y * SIZE + x) * 4
    rgba[i] = Math.round(clamp01(col[0]) * 255)
    rgba[i + 1] = Math.round(clamp01(col[1]) * 255)
    rgba[i + 2] = Math.round(clamp01(col[2]) * 255)
    rgba[i + 3] = Math.round(clamp01(col[3]) * 255)
  }
}

// ---------- outputs ----------
mkdirSync(BUILD, { recursive: true })
writeFileSync(path.join(BUILD, 'icon.png'), encodePNG(rgba, SIZE, SIZE))
console.log('[icons] build/icon.png written (1024×1024)')

// macOS iconset → icns
const iconset = path.join(BUILD, 'icon.iconset')
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })
const src = path.join(BUILD, 'icon.png')
for (const s of [16, 32, 64, 128, 256, 512]) {
  execFileSync('/usr/bin/sips', ['-z', String(s), String(s), src, '--out', path.join(iconset, `icon_${s}x${s}.png`)], { stdio: 'pipe' })
  const s2 = s * 2
  execFileSync('/usr/bin/sips', ['-z', String(s2), String(s2), src, '--out', path.join(iconset, `icon_${s}x${s}@2x.png`)], { stdio: 'pipe' })
}
const icns = path.join(BUILD, 'icon.icns')
execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icns], { stdio: 'pipe' })
if (!existsSync(icns)) throw new Error('iconutil failed to produce icon.icns')
console.log('[icons] build/icon.icns written')
