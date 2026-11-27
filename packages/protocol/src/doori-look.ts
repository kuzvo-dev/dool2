// The look the user dresses Doori in, validated where it is saved (PC settings) and received (phone link)
import { z } from 'zod'
import {
  DOORI_BODIES,
  DOORI_COLORS,
  DOORI_EYES,
  DOORI_FACES,
  DOORI_HATS,
  DOORI_NECKS,
  DOORI_PATTERNS,
} from './doori-draw.js'

export * from './doori-draw.js'

const oneOf = (list: readonly string[]) => z.string().refine((v) => v === '' || list.includes(v))
/** The look the user picked (saved in the PC settings, sent to the phones). Empty or missing = the default mint Doori */
export const DooriLookSchema = z.object({
  color: oneOf(Object.keys(DOORI_COLORS)).optional(),
  body: oneOf(Object.keys(DOORI_BODIES)).optional(),
  eyes: oneOf(DOORI_EYES).optional(),
  cheeks: z.boolean().optional(),
  pattern: oneOf(DOORI_PATTERNS).optional(),
  hat: oneOf(DOORI_HATS).optional(),
  face: oneOf(DOORI_FACES).optional(),
  neck: oneOf(DOORI_NECKS).optional(),
})
