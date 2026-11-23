// My info (values for booker/orderer form fields). Kept only in the secret store shared with the vault (the PC app uses the OS keychain).
// The AI never receives values: browser_fill_profile only names the field and item ("English last name for this box"), and the daemon hands the value straight to the extension.
// The AI, chat history and phone notifications only see masked values (like H*G, 010-****-5678).
import type { Lang } from '@dool2/i18n'
import { AUTH_APPS, CARRIERS } from '@dool2/protocol'
import { PROFILE_TEXT } from './locales/profile.js'
import {
  AUTH_APP_EXAMPLE,
  CAR_NO_EXAMPLE,
  CAR_NO_PATTERN,
  CAR_NO_RE,
  normalizeCarrier,
  normalizeSex,
  SEX_EXAMPLE,
  SEX_OPTIONS,
} from './region/kr/profile.js'
import type { SecretStoreLike } from './vault.js'

const KEY = 'profile.v1'

/** Fields we store (the raw values people type). Labels, hints and examples come from the catalog for `lang` */
export function profileFields(lang: Lang = 'ko') {
  const t = PROFILE_TEXT[lang]
  const en = (k: 'name_en_last' | 'name_en_first') => ({
    label: t[k].label as string,
    type: 'text' as const,
    pattern: '^[A-Za-z][A-Za-z -]*$',
    patternHint: t[k].hint as string,
  })
  return {
    name: { label: t.name.label as string, type: 'text', example: t.name.example as string },
    name_en_last: { ...en('name_en_last'), example: 'HONG' },
    name_en_first: { ...en('name_en_first'), example: 'GILDONG' },
    email: {
      label: t.email.label as string,
      type: 'email',
      example: 'me@example.com',
      pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
      patternHint: t.email.hint as string,
    },
    phone: {
      label: t.phone.label as string,
      type: 'tel',
      example: '010-1234-5678',
      pattern: '^01[016789]-?\\d{3,4}-?\\d{4}$',
      patternHint: t.phone.hint as string,
    },
    birth: {
      label: t.birth.label as string,
      type: 'date',
      example: '1990-01-31',
      pattern: '^(\\d{4}-?\\d{2}-?\\d{2}|\\d{6})$',
      patternHint: t.birth.hint as string,
    },
    zip: {
      label: t.zip.label as string,
      type: 'text',
      example: '06236',
      pattern: '^\\d{5}$',
      patternHint: t.zip.hint as string,
    },
    address: { label: t.address.label as string, type: 'text', example: t.address.example as string },
    address_detail: {
      label: t.address_detail.label as string,
      type: 'text',
      example: t.address_detail.example as string,
    },
    // Back digits of the resident ID: used in identity checks. Kept in the vault; the AI only sees a masked value (*******)
    rrn_back: {
      label: t.rrn_back.label as string,
      type: 'secret',
      example: '1234567',
      pattern: '^[1-4]\\d{6}$',
      patternHint: t.rrn_back.hint as string,
    },
    // The app Dool picks in the simple-auth window. Not a secret, so the AI sees it as is
    auth_app: {
      label: t.auth_app.label as string,
      type: 'choice',
      example: AUTH_APP_EXAMPLE,
      options: AUTH_APPS,
    },
    // Mobile carrier: picked in identity-check windows (PASS, SMS). Not a secret, so the AI sees it as is
    carrier: { label: t.carrier.label as string, type: 'choice', example: 'SKT', options: CARRIERS },
    // Passport: for overseas travel authorization (ESTA etc.), flights and overseas lodging forms
    // (measured 11-21: at ESTA it did not know the passport and asked the user to put a photo in a PC folder)
    passport_no: {
      label: t.passport_no.label as string,
      type: 'secret',
      example: 'M12345678',
      pattern: '^[A-Za-z]{1,2}\\d{7,8}$',
      patternHint: t.passport_no.hint as string,
    },
    passport_issued: {
      label: t.passport_issued.label as string,
      type: 'date',
      example: '2022-03-15',
      pattern: '^\\d{4}-?\\d{2}-?\\d{2}$',
      patternHint: t.passport_issued.hint as string,
    },
    passport_expiry: {
      label: t.passport_expiry.label as string,
      type: 'date',
      example: '2032-03-15',
      pattern: '^\\d{4}-?\\d{2}-?\\d{2}$',
      patternHint: t.passport_expiry.hint as string,
    },
    sex: { label: t.sex.label as string, type: 'choice', example: SEX_EXAMPLE, options: SEX_OPTIONS },
    // Vehicle number: for inspection, recall, annual car tax prepay and insurance quotes. It goes into lookup boxes, so the AI sees it as is
    // (measured 11-21: four requests (inspection, prepay, recall, insurance) each asked for the number in chat)
    car_no: {
      label: t.car_no.label as string,
      type: 'text',
      example: CAR_NO_EXAMPLE,
      pattern: CAR_NO_PATTERN,
      patternHint: t.car_no.hint as string,
    },
    birth_city: {
      label: t.birth_city.label as string,
      type: 'text',
      example: 'SEOUL',
      pattern: '^[A-Za-z][A-Za-z .-]*$',
      patternHint: t.birth_city.hint as string,
    },
  } as const
}

export const PROFILE_FIELDS = profileFields('ko')

export type ProfileField = keyof typeof PROFILE_FIELDS
export type Profile = Partial<Record<ProfileField, string>>

/** Shapes a value can take when filled into a box (each site accepts a different shape) */
export const PROFILE_KEYS = [
  ...(Object.keys(PROFILE_FIELDS) as ProfileField[]),
  'name_en_full', // HONG GILDONG
  'phone_digits', // 01012345678
  'phone_local', // 1012345678 (boxes where the country code is picked separately: after +82)
  'phone_rest', // 12345678 (boxes where the leading 010 is picked separately: last 8 digits)
  'phone_head', // 010 (mobile number split in three boxes: first)
  'phone_mid', // 1234 (mobile number split in three boxes: middle)
  'phone_last', // 5678 (mobile number split in three boxes: last)
  'birth_digits', // 19900131
  'birth6', // 900131
] as const
export type ProfileKey = (typeof PROFILE_KEYS)[number]

/** Items needed to build this shape */
export function sourceOf(key: ProfileKey): ProfileField[] {
  switch (key) {
    case 'name_en_full':
      return ['name_en_last', 'name_en_first']
    case 'phone_digits':
    case 'phone_local':
    case 'phone_rest':
    case 'phone_head':
    case 'phone_mid':
    case 'phone_last':
      return ['phone']
    case 'birth_digits':
    case 'birth6':
      return ['birth']
    default:
      return [key]
  }
}

/** Builds the shape to fill from the stored values; undefined if missing */
export function profileValue(p: Profile, key: ProfileKey): string | undefined {
  const digits = (s?: string) => s?.replace(/\D/g, '') || undefined
  switch (key) {
    case 'name_en_full':
      return p.name_en_last && p.name_en_first ? `${p.name_en_last} ${p.name_en_first}` : undefined
    case 'phone_digits':
      return digits(p.phone)
    case 'phone_local': {
      const d = digits(p.phone)
      return d?.replace(/^0/, '')
    }
    case 'phone_rest':
      return digits(p.phone)?.slice(3)
    case 'phone_head':
      return digits(p.phone)?.slice(0, 3)
    case 'phone_mid':
      return digits(p.phone)?.slice(3, -4)
    case 'phone_last':
      return digits(p.phone)?.slice(-4)
    case 'birth_digits':
      return digits(p.birth)
    case 'birth6':
      return digits(p.birth)?.slice(2)
    default:
      return p[key]?.trim() || undefined
  }
}

/** Masked value shown to the AI and in logs */
export function maskValue(field: ProfileField, v: string): string {
  const s = v.trim()
  if (field === 'auth_app' || field === 'carrier') return s
  if (field === 'rrn_back') return '*******'
  if (field === 'passport_no') return `${s.slice(0, 1)}********`
  if (field === 'sex' || field === 'birth_city' || field === 'car_no') return s
  if (field === 'passport_issued' || field === 'passport_expiry') return `${s.slice(0, 4)}-**-**`
  if (field === 'email') {
    const [user = '', host = ''] = s.split('@')
    return `${user.slice(0, 2)}${'*'.repeat(Math.max(1, user.length - 2))}@${host}`
  }
  if (field === 'phone') {
    const d = s.replace(/\D/g, '')
    return d.length >= 8 ? `${d.slice(0, 3)}-****-${d.slice(-4)}` : '****'
  }
  if (field === 'birth') return `${s.slice(0, 4)}-**-**`
  if (field === 'address' || field === 'address_detail') return `${s.split(/\s+/).slice(0, 2).join(' ')} ***`
  if (field === 'zip') return `${s.slice(0, 2)}***`
  // Name: mask the middle (H**G)
  if (s.length <= 1) return '*'
  if (s.length === 2) return `${s[0]}*`
  return `${s[0]}${'*'.repeat(s.length - 2)}${s.at(-1)}`
}

/** Tidies a typed value: English names upper case, phone digits and hyphens only, birth date as YYYY-MM-DD */
export function normalize(field: ProfileField, v: string): string | undefined {
  const s = v.replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!s) return undefined
  if (field === 'name_en_last' || field === 'name_en_first' || field === 'birth_city') return s.toUpperCase()
  if (field === 'passport_no') {
    const k = s.replace(/\s/g, '').toUpperCase()
    return /^[A-Z]{1,2}\d{7,8}$/.test(k) ? k : undefined
  }
  if (field === 'passport_issued' || field === 'passport_expiry') {
    const d = s.replace(/\D/g, '')
    return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : undefined
  }
  if (field === 'car_no') {
    const m = CAR_NO_RE.exec(s)
    return m ? `${m[1]}${m[2]} ${m[3]}` : undefined
  }
  if (field === 'sex') return normalizeSex(s)
  if (field === 'phone') {
    const d = s.replace(/\D/g, '')
    if (d.length < 9) return undefined
    return d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : d
  }
  if (field === 'birth') {
    const d = s.replace(/\D/g, '')
    const full = d.length === 6 ? `${Number(d.slice(0, 2)) > 30 ? '19' : '20'}${d}` : d
    if (full.length !== 8) return undefined
    return `${full.slice(0, 4)}-${full.slice(4, 6)}-${full.slice(6)}`
  }
  if (field === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return undefined
  if (field === 'rrn_back') {
    const d = s.replace(/\D/g, '')
    return /^[1-4]\d{6}$/.test(d) ? d : undefined
  }
  if (field === 'carrier') return normalizeCarrier(s)
  if (field === 'auth_app') {
    // A prefix is enough: "pass" matches PASS, "kakao" matches the KakaoTalk entry
    const k = s.replace(/\s/g, '').toLowerCase()
    return (
      AUTH_APPS.find((a) => a.toLowerCase() === k) ??
      AUTH_APPS.find((a) => a.toLowerCase().startsWith(k.slice(0, 2))) ??
      // Apps that differ by site (e.g. Hana certificate) are kept as the screen text
      (s.length <= 20 ? s : undefined)
    )
  }
  return s
}

export class ProfileStore {
  constructor(private readonly secrets: SecretStoreLike) {}

  async get(): Promise<Profile> {
    const raw = await this.secrets.get(KEY)
    if (!raw) return {}
    try {
      const v = JSON.parse(raw) as Profile
      return v && typeof v === 'object' ? v : {}
    } catch {
      return {}
    }
  }

  /** Changes only the fields given. Empty values are deleted. Fields with a wrong format are skipped and returned by name */
  async update(input: Record<string, unknown>): Promise<{ saved: ProfileField[]; bad: ProfileField[] }> {
    const p = await this.get()
    const saved: ProfileField[] = []
    const bad: ProfileField[] = []
    for (const field of Object.keys(PROFILE_FIELDS) as ProfileField[]) {
      if (!(field in input)) continue
      const raw = input[field]
      if (raw === null || raw === '') {
        delete p[field]
        continue
      }
      if (typeof raw !== 'string') continue
      const v = normalize(field, raw)
      if (v) {
        p[field] = v
        saved.push(field)
      } else bad.push(field)
    }
    await this.secrets.set(KEY, Object.keys(p).length ? JSON.stringify(p) : undefined)
    return { saved, bad }
  }

  async clear() {
    await this.secrets.set(KEY, undefined)
  }

  /** Shape shown to the AI: masked values for items that exist, just the name for the missing ones */
  async masked(): Promise<{ have: Partial<Record<ProfileField, string>>; missing: ProfileField[] }> {
    const p = await this.get()
    const have: Partial<Record<ProfileField, string>> = {}
    const missing: ProfileField[] = []
    for (const field of Object.keys(PROFILE_FIELDS) as ProfileField[]) {
      const v = p[field]
      if (v) have[field] = maskValue(field, v)
      else missing.push(field)
    }
    return { have, missing }
  }
}
