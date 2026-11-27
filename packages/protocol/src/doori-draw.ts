// The Dool2 character drawn as one SVG (no imports: the PC app copies this file as is) (no 3D, no images): the flat Doori without legs, and the look the user picks
// for it (colour, body, eyes, cheeks, pattern, hat, glasses, neck). Shared by the phone and PC apps so both draw the
// same Doori. What stays Doori whatever the look: a rounded-square body family, upright eyes, the keyhole mouth and
// the "2" dot (design decision 2026-11-27, mock exports/dool2-redesign-mock).

export const DOORI_COLORS = {
  mint: '#4cc98f',
  sky: '#58a8f0',
  grape: '#9a7cf0',
  peach: '#f59a7a',
  pink: '#f07ba8',
  butter: '#f2c94c',
  tangerine: '#f2a03d',
  cocoa: '#8c6f56',
  slate: '#7d8794',
  snow: '#f4f4ef',
  night: '#2f3b4c',
  lime: '#a6d84a',
} as const

interface Body {
  x: number
  y: number
  w: number
  h: number
  r: number
  bean?: boolean
}
/** Proportions of the same rounded square only (never other characters' shapes) */
export const DOORI_BODIES: Record<string, Body> = {
  square: { x: 14, y: 18, w: 92, h: 88, r: 30 },
  round: { x: 14, y: 18, w: 92, h: 88, r: 44 },
  tall: { x: 22, y: 10, w: 76, h: 98, r: 30 },
  wide: { x: 8, y: 28, w: 104, h: 76, r: 30 },
  bean: { x: 14, y: 18, w: 92, h: 88, r: 30, bean: true },
}
export const DOORI_EYES = ['pill', 'sparkle', 'dot', 'wink', 'sleepy'] as const
export const DOORI_PATTERNS = ['spots', 'belly', 'stripe'] as const

const HATS: Record<string, string> = {
  beret:
    '<ellipse cx="54" cy="16" rx="30" ry="10" fill="#2a2a2a"/><circle cx="54" cy="5" r="3.5" fill="#2a2a2a"/>',
  cap: '<path d="M26 22 q34 -26 68 0 z" fill="#e2504a"/><rect x="70" y="18" width="34" height="7" rx="3.5" fill="#c23f3a"/>',
  beanie:
    '<path d="M24 24 q36 -34 72 0 z" fill="#f2a03d"/><rect x="22" y="20" width="76" height="9" rx="4.5" fill="#d9862a"/><circle cx="60" cy="-2" r="6" fill="#f2a03d"/>',
  crown:
    '<path d="M34 22 l6 -18 l10 12 l10 -14 l10 14 l10 -12 l6 18 z" fill="#f2c94c" stroke="#c99a1c" stroke-width="2"/>',
  chef: '<rect x="34" y="12" width="52" height="12" rx="3" fill="#fff" stroke="#ddd"/><circle cx="44" cy="6" r="10" fill="#fff" stroke="#ddd"/><circle cx="60" cy="2" r="11" fill="#fff" stroke="#ddd"/><circle cx="76" cy="6" r="10" fill="#fff" stroke="#ddd"/>',
  grad: '<path d="M20 14 l40 -12 l40 12 l-40 12 z" fill="#2a2a2a"/><path d="M96 15 v14" stroke="#f2c94c" stroke-width="3"/><circle cx="96" cy="31" r="3.5" fill="#f2c94c"/>',
  sprout:
    '<path d="M60 18 v-12" stroke="#3b9a5c" stroke-width="4" stroke-linecap="round"/><ellipse cx="51" cy="5" rx="9" ry="5" fill="#5cc276" transform="rotate(-25 51 5)"/><ellipse cx="69" cy="5" rx="9" ry="5" fill="#5cc276" transform="rotate(25 69 5)"/>',
  headset:
    '<path d="M16 54 q44 -62 88 0" stroke="#222" stroke-width="5" fill="none"/><rect x="7" y="46" width="13" height="22" rx="5" fill="#222"/><rect x="100" y="46" width="13" height="22" rx="5" fill="#222"/><path d="M14 68 q6 20 30 20" stroke="#222" stroke-width="3" fill="none"/><circle cx="45" cy="88" r="4" fill="#222"/>',
  bow: '<path d="M82 16 l16 -9 v20 z M82 16 l-16 -9 v20 z" fill="#e2557a"/><circle cx="82" cy="16" r="4.5" fill="#c23f63"/>',
}
const FACES: Record<string, (a: number, b: number, y: number) => string> = {
  round: (a, b, y) =>
    `<circle cx="${a}" cy="${y}" r="12" fill="none" stroke="#222" stroke-width="3.5"/><circle cx="${b}" cy="${y}" r="12" fill="none" stroke="#222" stroke-width="3.5"/><path d="M${a + 12} ${y} h${b - a - 24}" stroke="#222" stroke-width="3.5"/>`,
  square: (a, b, y) =>
    `<rect x="${a - 13}" y="${y - 10}" width="26" height="20" rx="5" fill="none" stroke="#222" stroke-width="3.5"/><rect x="${b - 13}" y="${y - 10}" width="26" height="20" rx="5" fill="none" stroke="#222" stroke-width="3.5"/><path d="M${a + 13} ${y} h${b - a - 26}" stroke="#222" stroke-width="3.5"/>`,
  sun: (a, b, y) =>
    `<rect x="${a - 14}" y="${y - 9}" width="28" height="19" rx="9" fill="#1d1d1d"/><rect x="${b - 14}" y="${y - 9}" width="28" height="19" rx="9" fill="#1d1d1d"/><path d="M${a + 14} ${y - 2} h${b - a - 28}" stroke="#1d1d1d" stroke-width="3.5"/>`,
  mono: (_a, b, y) =>
    `<circle cx="${b}" cy="${y}" r="12" fill="none" stroke="#c99a1c" stroke-width="3.5"/><path d="M${b + 10} ${y + 6} q6 14 0 30" stroke="#c99a1c" stroke-width="2" fill="none"/>`,
}
const NECKS: Record<string, (cx: number, by: number) => string> = {
  tie: (cx, by) => `<path d="M${cx - 6} ${by - 14} h12 l-3 6 l5 16 l-8 8 l-8 -8 l5 -16 z" fill="#2f5fd0"/>`,
  scarf: (cx, by) =>
    `<rect x="${cx - 34}" y="${by - 18}" width="68" height="12" rx="6" fill="#e2504a"/><rect x="${cx + 14}" y="${by - 10}" width="11" height="20" rx="4" fill="#c23f3a"/>`,
  bandana: (cx, by) => `<path d="M${cx - 30} ${by - 18} h60 l-30 20 z" fill="#58a8f0"/>`,
  badge: (cx, by) =>
    `<circle cx="${cx + 22}" cy="${by - 20}" r="8" fill="#f2c94c" stroke="#c99a1c" stroke-width="2"/><text x="${cx + 22}" y="${by - 16}" text-anchor="middle" font-size="9" font-weight="800" fill="#7a5600" font-family="system-ui">2</text>`,
}
export const DOORI_HATS = Object.keys(HATS)
export const DOORI_FACES = Object.keys(FACES)
export const DOORI_NECKS = Object.keys(NECKS)

export type DooriMood = 'idle' | 'thinking' | 'working' | 'asking' | 'done' | 'sleeping' | ''

const INK = '#16241d'

function shade(hex: string, f: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)))
  return `#${[c(n >> 16), c((n >> 8) & 255), c(n & 255)].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}
function isLight(hex: string): boolean {
  const n = Number.parseInt(hex.slice(1), 16)
  return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 200
}

function eyesSvg(style: string, mood: DooriMood, cx1: number, cx2: number, cy: number): string {
  const curve = (cx: number, up: boolean) =>
    `<path d="M${cx - 7} ${cy + (up ? 2 : 0)} q7 ${up ? -10 : 6} 14 0" stroke="${INK}" stroke-width="5" fill="none" stroke-linecap="round"/>`
  if (mood === 'done') return curve(cx1, true) + curve(cx2, true)
  if (mood === 'sleeping') return curve(cx1, false) + curve(cx2, false)
  const h = mood === 'working' ? 13 : mood === 'asking' ? 22 : 19
  const dy = mood === 'thinking' ? -4 : 0
  const dx = mood === 'thinking' ? 4 : 0
  const one = (cx: number, second: boolean) => {
    const x = cx + dx
    const y = cy - h / 2 + dy
    if (style === 'dot') return `<circle cx="${x}" cy="${cy + dy}" r="6" fill="${INK}"/>`
    if (style === 'sparkle')
      return `<rect x="${x - 5.5}" y="${y}" width="11" height="${h}" rx="5.5" fill="${INK}"/><circle cx="${x + 2}" cy="${y + 5}" r="2.3" fill="#fff"/>`
    if (style === 'wink' && second && (mood === 'idle' || mood === ''))
      return `<path d="M${x - 7} ${cy} q7 -8 14 0" stroke="${INK}" stroke-width="5" fill="none" stroke-linecap="round"/>`
    if (style === 'sleepy')
      return `<rect x="${x - 6}" y="${cy - 2 + dy}" width="12" height="8" rx="4" fill="${INK}"/>`
    return `<rect x="${x - 5}" y="${y}" width="10" height="${h}" rx="5" fill="${INK}"/>`
  }
  return one(cx1, false) + one(cx2, true)
}

let clipSeq = 0

/** How the user dressed Doori (validated by DooriLookSchema in doori-look.ts) */
export interface DooriLook {
  color?: string
  body?: string
  eyes?: string
  cheeks?: boolean
  pattern?: string
  hat?: string
  face?: string
  neck?: string
}

export interface DrawOptions extends DooriLook {
  mood?: DooriMood
  /** Colour of the "2" dot and side marks (light on dark backgrounds) */
  dotColor?: string
}

/** The Doori as an SVG string (viewBox 120 wide; the caller sizes it with CSS) */
export function drawDoori(o: DrawOptions = {}): string {
  const color = DOORI_COLORS[o.color as keyof typeof DOORI_COLORS] ?? DOORI_COLORS.mint
  const b = DOORI_BODIES[o.body ?? ''] ?? (DOORI_BODIES.square as Body)
  const mood = o.mood ?? 'idle'
  const cy = b.y + b.h * 0.42
  const cx1 = 60 - b.w * 0.18
  const cx2 = 60 + b.w * 0.18
  const clip = `dc${++clipSeq}`
  const beanPath = 'M30 22 q30 -10 60 0 q22 8 18 44 q-2 40 -48 40 q-46 0 -48 -40 q-4 -36 18 -44 z'
  const shape = b.bean
    ? `<path d="${beanPath}"/>`
    : `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${b.r}"/>`
  const body = shape.replace('/>', ` fill="${color}"/>`)
  const patFill = isLight(color) ? shade(color, 0.88) : shade(color, 1.18)
  const patterns: Record<string, string> = {
    spots: `<circle cx="36" cy="88" r="5" fill="${patFill}"/><circle cx="88" cy="40" r="4" fill="${patFill}"/><circle cx="84" cy="92" r="3" fill="${patFill}"/><circle cx="30" cy="40" r="3" fill="${patFill}"/>`,
    belly: `<ellipse cx="60" cy="98" rx="30" ry="14" fill="${patFill}"/>`,
    stripe: `<rect x="14" y="80" width="92" height="9" fill="${patFill}"/>`,
  }
  const pat =
    o.pattern && patterns[o.pattern] ? `<g clip-path="url(#${clip})">${patterns[o.pattern]}</g>` : ''
  const cheeks = o.cheeks
    ? `<ellipse cx="${cx1 - 10}" cy="${cy + 16}" rx="7" ry="4.5" fill="#ff8f8f" opacity=".55"/><ellipse cx="${cx2 + 10}" cy="${cy + 16}" rx="7" ry="4.5" fill="#ff8f8f" opacity=".55"/>`
    : ''
  const my = cy + 20
  const mouth =
    mood === 'done'
      ? `<path d="M54 ${my - 2} q6 6 12 0" stroke="${INK}" stroke-width="4" fill="none" stroke-linecap="round"/>`
      : `<circle cx="60" cy="${my}" r="4" fill="${INK}"/><path d="M58 ${my + 2} h4 l1.2 7 h-6.4 z" fill="${INK}"/>`
  const dot = o.dotColor ?? INK
  const side =
    mood === 'thinking'
      ? `<circle cx="106" cy="16" r="5" fill="${dot}" opacity=".35"/><circle cx="113" cy="6" r="3.5" fill="${dot}" opacity=".25"/>`
      : mood === 'sleeping'
        ? `<text x="98" y="20" font-size="15" font-weight="800" fill="${dot}" opacity=".55" font-family="system-ui">z</text>`
        : mood === 'asking'
          ? '<text x="99" y="22" font-size="19" font-weight="800" fill="#e0a800" font-family="system-ui">?</text>'
          : o.hat
            ? ''
            : `<circle cx="${b.x + b.w - 6}" cy="${b.y + 4}" r="7" fill="${dot}"/>`
  const face =
    o.face && FACES[o.face]
      ? (FACES[o.face] as (a: number, b: number, y: number) => string)(cx1, cx2, cy)
      : ''
  const neck =
    o.neck && NECKS[o.neck] ? (NECKS[o.neck] as (cx: number, by: number) => string)(60, b.y + b.h) : ''
  const hat = o.hat && HATS[o.hat] ? `<g transform="translate(0 ${b.y - 18})">${HATS[o.hat]}</g>` : ''
  return `<svg viewBox="0 -6 120 126" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><clipPath id="${clip}">${shape}</clipPath></defs>${body}${pat}${cheeks}${eyesSvg(o.eyes ?? 'pill', mood, cx1, cx2, cy)}${mouth}${neck}${face}${hat}${side}</svg>`
}

/** A random look (the "make one for me" button) */
export function randomLook(rand: () => number = Math.random): DooriLook {
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)] as T
  return {
    color: pick(Object.keys(DOORI_COLORS)),
    body: pick(Object.keys(DOORI_BODIES)),
    eyes: pick(['pill', 'sparkle', 'dot', 'wink']),
    cheeks: rand() > 0.5,
    pattern: pick(['', '', ...DOORI_PATTERNS]),
    hat: pick(['', '', ...DOORI_HATS]),
    face: pick(['', '', '', ...DOORI_FACES]),
    neck: pick(['', '', ...DOORI_NECKS]),
  }
}
