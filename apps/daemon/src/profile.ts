// 내 정보 (예약자·주문자 칸에 넣을 값). 금고와 같은 비밀값 보관소(PC 앱은 OS 키체인)에만 둔다.
// AI는 값을 받지 않는다: browser_fill_profile은 "이 칸에 영문 성"처럼 칸과 항목만 말하고, 본체가 확장에 직접 넘긴다.
// AI·대화 기록·폰 알림에는 가린 값(홍*동, 010-****-5678)만 보인다.
import type { SecretStoreLike } from './vault.js'

const KEY = 'profile.v1'

/** 저장하는 항목 (사람이 넣는 원래 값) */
export const PROFILE_FIELDS = {
  name: { label: '이름', type: 'text', example: '홍길동' },
  name_en_last: { label: '영문 성', type: 'text', example: 'HONG' },
  name_en_first: { label: '영문 이름', type: 'text', example: 'GILDONG' },
  email: { label: '이메일', type: 'email', example: 'me@example.com' },
  phone: { label: '휴대폰 번호', type: 'tel', example: '010-1234-5678' },
  birth: { label: '생년월일', type: 'date', example: '1990-01-31' },
  zip: { label: '우편번호', type: 'text', example: '06236' },
  address: { label: '주소', type: 'text', example: '서울 강남구 테헤란로 123' },
  address_detail: { label: '상세 주소', type: 'text', example: '4층 401호' },
} as const

export type ProfileField = keyof typeof PROFILE_FIELDS
export type Profile = Partial<Record<ProfileField, string>>

/** 칸에 넣을 때 고를 수 있는 모양 (사이트마다 받는 모양이 다르다) */
export const PROFILE_KEYS = [
  ...(Object.keys(PROFILE_FIELDS) as ProfileField[]),
  'name_en_full', // HONG GILDONG
  'phone_digits', // 01012345678
  'phone_local', // 1012345678 (국가 번호를 따로 고르는 칸: +82 다음)
  'birth_digits', // 19900131
  'birth6', // 900131
] as const
export type ProfileKey = (typeof PROFILE_KEYS)[number]

/** 이 모양을 만들려면 있어야 하는 항목 */
export function sourceOf(key: ProfileKey): ProfileField[] {
  switch (key) {
    case 'name_en_full':
      return ['name_en_last', 'name_en_first']
    case 'phone_digits':
    case 'phone_local':
      return ['phone']
    case 'birth_digits':
    case 'birth6':
      return ['birth']
    default:
      return [key]
  }
}

/** 저장된 값에서 칸에 넣을 모양을 만든다. 없으면 undefined */
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
    case 'birth_digits':
      return digits(p.birth)
    case 'birth6':
      return digits(p.birth)?.slice(2)
    default:
      return p[key]?.trim() || undefined
  }
}

/** AI·기록에 보일 가린 값 */
export function maskValue(field: ProfileField, v: string): string {
  const s = v.trim()
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
  // 이름: 가운데를 가린다 (홍*동, H**G)
  if (s.length <= 1) return '*'
  if (s.length === 2) return `${s[0]}*`
  return `${s[0]}${'*'.repeat(s.length - 2)}${s.at(-1)}`
}

/** 넣은 값 다듬기: 영문 이름은 대문자, 전화는 숫자·하이픈만, 생년월일은 YYYY-MM-DD */
export function normalize(field: ProfileField, v: string): string | undefined {
  const s = v.replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!s) return undefined
  if (field === 'name_en_last' || field === 'name_en_first') return s.toUpperCase()
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

  /** 넣은 칸만 바꾼다. 빈 값은 지운다. 형식이 틀린 칸은 넘기고 그 이름을 돌려준다 */
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

  /** AI에게 보일 모양: 있는 항목은 가린 값, 없는 항목은 이름만 */
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
