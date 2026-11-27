// Phone app: "My Doori" — dressing Doori (colour, body, eyes, cheeks, pattern, hat, glasses, neck). Each pick shows
// at once on the phone and goes to the PC, which keeps it and tells every phone (settings dooriLook)
import {
  DOORI_BODIES,
  DOORI_COLORS,
  DOORI_EYES,
  DOORI_FACES,
  DOORI_HATS,
  DOORI_NECKS,
  DOORI_PATTERNS,
  type DooriLook,
  drawDoori,
  randomLook,
} from '@dool2/protocol/doori-look'
import { doori, dooriLook, h, setDooriLook } from '../dom.js'
import { tDoori } from '../locales/doori-maker.js'
import { send } from './core.js'
import { render } from './shell.js'

type Part = 'body' | 'eyes' | 'hat' | 'face' | 'neck'

const NAMES: Record<string, string> = {
  'body:square': tDoori.bodySquare,
  'body:round': tDoori.bodyRound,
  'body:tall': tDoori.bodyTall,
  'body:wide': tDoori.bodyWide,
  'body:bean': tDoori.bodyBean,
  'eyes:pill': tDoori.eyesPill,
  'eyes:sparkle': tDoori.eyesSparkle,
  'eyes:dot': tDoori.eyesDot,
  'eyes:wink': tDoori.eyesWink,
  'eyes:sleepy': tDoori.eyesSleepy,
  'hat:beret': tDoori.hatBeret,
  'hat:cap': tDoori.hatCap,
  'hat:beanie': tDoori.hatBeanie,
  'hat:crown': tDoori.hatCrown,
  'hat:chef': tDoori.hatChef,
  'hat:grad': tDoori.hatGrad,
  'hat:sprout': tDoori.hatSprout,
  'hat:headset': tDoori.hatHeadset,
  'hat:bow': tDoori.hatBow,
  'face:round': tDoori.faceRound,
  'face:square': tDoori.faceSquare,
  'face:sun': tDoori.faceSun,
  'face:mono': tDoori.faceMono,
  'neck:tie': tDoori.neckTie,
  'neck:scarf': tDoori.neckScarf,
  'neck:bandana': tDoori.neckBandana,
  'neck:badge': tDoori.neckBadge,
  'pattern:spots': tDoori.patSpots,
  'pattern:belly': tDoori.patBelly,
  'pattern:stripe': tDoori.patStripe,
}

/** Apply a look: shown right away, kept by the PC */
function apply(look: DooriLook) {
  setDooriLook(look)
  void send({ kind: 'doori-look', look })
  render()
}

function svgBox(svg: string, cls: string) {
  const b = h('span', { class: cls })
  b.innerHTML = svg
  return b
}

export function dooriMakerSheet() {
  const look = dooriLook()
  const sheet = h('section', { class: 'sheet float app-sheet rise doori-maker' })
  const stage = h(
    'div',
    { class: 'dm-stage' },
    doori('', 150),
    h(
      'div',
      { class: 'dm-actions' },
      h('button', { class: 'btn', text: `🎲 ${tDoori.random}`, onclick: () => apply(randomLook()) }),
      h('button', { class: 'btn-ghost', text: tDoori.reset, onclick: () => apply({}) }),
    ),
  )
  sheet.append(
    h(
      'div',
      { class: 'approve-head' },
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: tDoori.title }),
        h('span', { class: 'meta', text: tDoori.sub }),
      ),
    ),
    stage,
  )
  const section = (title: string, ...items: Node[]) =>
    sheet.append(h('h3', { class: 'dm-h', text: title }), h('div', { class: 'dm-opts' }, ...items))

  // Colour: swatches
  section(
    tDoori.color,
    ...Object.entries(DOORI_COLORS).map(([k, v]) => {
      const on = (look.color ?? 'mint') === k
      const b = h('button', {
        class: `dm-color${on ? ' on' : ''}`,
        label: k,
        onclick: () => apply({ ...look, color: k }),
      })
      b.style.background = v
      return b
    }),
  )
  // Picture options: each shows Doori wearing it
  const pics = (part: Part, values: readonly string[], withNone: boolean) =>
    [...(withNone ? [''] : []), ...values].map((v) => {
      const cur = look[part] ?? (part === 'body' ? 'square' : part === 'eyes' ? 'pill' : '')
      const preview: DooriLook = {
        ...look,
        [part]: v,
        ...(part === 'body' || part === 'eyes' ? { hat: '', face: '', neck: '' } : {}),
      }
      return h(
        'button',
        { class: `dm-pic${cur === v ? ' on' : ''}`, onclick: () => apply({ ...look, [part]: v }) },
        svgBox(drawDoori(preview), 'dm-mini'),
        h('span', { text: v ? (NAMES[`${part}:${v}`] ?? v) : tDoori.none }),
      )
    })
  section(tDoori.body, ...pics('body', Object.keys(DOORI_BODIES), false))
  section(tDoori.eyes, ...pics('eyes', DOORI_EYES, false))
  // Cheeks and pattern: chips
  section(
    tDoori.extra,
    h('button', {
      class: `chip${look.cheeks ? ' on' : ''}`,
      text: tDoori.cheeks,
      onclick: () => apply({ ...look, cheeks: !look.cheeks }),
    }),
    ...['', ...DOORI_PATTERNS].map((p) =>
      h('button', {
        class: `chip${(look.pattern ?? '') === p ? ' on' : ''}`,
        text: p ? (NAMES[`pattern:${p}`] ?? p) : tDoori.noPattern,
        onclick: () => apply({ ...look, pattern: p }),
      }),
    ),
  )
  section(tDoori.hat, ...pics('hat', DOORI_HATS, true))
  section(tDoori.face, ...pics('face', DOORI_FACES, true))
  section(tDoori.neck, ...pics('neck', DOORI_NECKS, true))
  return sheet
}
