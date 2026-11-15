// 서비스 연결: 사용자가 로그인 카드에 넣은 아이디·비밀번호로 두리 본체가 직접 로그인한다 (AI를 거치지 않는다).
// 1) 사이트를 열고 로그인 화면을 찾는다 (비밀번호 칸이 없으면 "로그인" 링크·버튼을 누른다)
// 2) 금고 값을 칸에 넣고 로그인 버튼(없으면 Enter)을 누른다
// 3) 화면 글자로 결과를 본다: 로그인됨 / 로봇 확인·본인인증(사람이 해야 함) / 아이디·비밀번호 틀림 / 모름
import type { ConnectCard } from '@dool2/protocol/connect'
import { parseRefs } from './browser-tools.js'
import { looksSignedIn } from './connect-watch.js'

export interface AutoLoginBrowser {
  call(method: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

export interface AutoLoginInput {
  card: Pick<ConnectCard, 'id' | 'name' | 'signedIn'>
  url: string
  username: string
  password: string
}

export type AutoLoginResult = (
  | { status: 'ok'; tabId: number }
  | { status: 'human'; tabId: number; reason: string }
  | { status: 'wrong'; tabId: number; message: string }
  | { status: 'unknown'; tabId: number; message: string }
) & {
  /** 비밀번호를 넣은 화면의 주소 (사이트 첫 화면과 다를 수 있어 금고에 같이 넣는다) */
  loginOrigin?: string
}

interface Snap {
  url: string
  title?: string
  text: string
  captcha?: boolean
}

const LOGIN_WORD = /^(로그인|로그인하기|login|log in|sign in|signin)$/i
const LOGIN_LINK = /로그인|log ?in|sign ?in/i
const USER_FIELD = /아이디|이메일|email|e-mail|\bid\b|휴대폰|전화|phone|계정|사용자/i
const HUMAN =
  /보안\s?문자|자동\s?입력\s?방지|로봇이 아닙니다|captcha|인증\s?번호|본인\s?인증|2단계|추가\s?인증|휴대폰\s?인증|기기\s?인증|새로운 기기|OTP/i
const WRONG =
  /(비밀번호|아이디|계정).{0,20}(잘못|틀|일치하지|확인해|올바르지|맞지 않)|등록되지 않은|incorrect|invalid (password|username|email)|wrong password/i

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function autoLogin(
  browser: AutoLoginBrowser,
  input: AutoLoginInput,
  opts: { wait?: number; tries?: number } = {},
): Promise<AutoLoginResult> {
  const wait = opts.wait ?? 1_500
  const snap = async (tabId: number) => (await browser.call('snapshot', { tabId, maxChars: 12_000 })) as Snap
  const opened = (await browser.call('open', { url: input.url }, 40_000)) as { tabId: number }
  const tabId = opened.tabId

  // 1) 로그인 화면 찾기: 비밀번호 칸이 보일 때까지 "로그인"을 누른다 (최대 3번)
  let page = await snap(tabId)
  if (looksSignedIn(input.card, page)) return { status: 'ok', tabId }
  for (let i = 0; i < 3 && !hasPassword(page.text); i++) {
    const refs = parseRefs(page.text)
    const target =
      [...refs].find(([, r]) => (r.role === '링크' || r.role === '버튼') && LOGIN_WORD.test(r.name.trim())) ??
      [...refs].find(([, r]) => (r.role === '링크' || r.role === '버튼') && LOGIN_LINK.test(r.name))
    if (!target) break
    await browser.call('click', { tabId, ref: target[0] }, 30_000).catch(() => undefined)
    await sleep(wait)
    page = await snap(tabId)
  }
  if (page.captcha || HUMAN.test(page.text)) return { status: 'human', tabId, reason: humanReason(page.text) }
  if (!hasPassword(page.text))
    return {
      status: 'unknown',
      tabId,
      message: '로그인 칸을 찾지 못했어요. 화면을 보면서 직접 로그인해 주세요.',
    }

  // 2) 칸 채우기 (확장이 주소를 다시 확인한다)
  const refs = parseRefs(page.text)
  const order = [...refs]
  const pwIndex = order.findIndex(([, r]) => r.role === '비밀번호칸')
  const pwRef = order[pwIndex]?.[0] as string
  const before = order.slice(0, pwIndex).filter(([, r]) => r.role === '입력칸' || r.role === '검색칸')
  const userRef = (before.findLast(([, r]) => USER_FIELD.test(r.name)) ?? before.at(-1))?.[0]
  const origin = new URL(page.url).origin
  const loginOrigin = origin
  if (userRef) await browser.call('fill', { tabId, ref: userRef, value: input.username, origin })
  await browser.call('fill', { tabId, ref: pwRef, value: input.password, origin, password: true })

  // 3) 로그인 누르기: 비밀번호 칸 뒤의 "로그인" 버튼, 없으면 Enter
  const after = order.slice(pwIndex + 1)
  const submit =
    after.find(([, r]) => r.role === '버튼' && LOGIN_WORD.test(r.name.trim())) ??
    after.find(([, r]) => r.role === '버튼' && LOGIN_LINK.test(r.name))
  if (submit) await browser.call('click', { tabId, ref: submit[0] }, 30_000).catch(() => undefined)
  else await browser.call('press', { tabId, key: 'Enter' }).catch(() => undefined)

  // 4) 결과 보기
  for (let i = 0; i < (opts.tries ?? 8); i++) {
    await sleep(wait)
    page = await snap(tabId).catch(() => page)
    if (looksSignedIn(input.card, page)) return { loginOrigin, status: 'ok', tabId }
    if (page.captcha || HUMAN.test(page.text))
      return { loginOrigin, status: 'human', tabId, reason: humanReason(page.text) }
    if (WRONG.test(page.text))
      return {
        loginOrigin,
        status: 'wrong',
        tabId,
        message: '아이디나 비밀번호가 맞지 않는 것 같아요. 다시 확인해 주세요.',
      }
  }
  return {
    status: 'unknown',
    tabId,
    message: '로그인됐는지 확인하지 못했어요. 화면을 보고 확인해 주세요.',
  }
}

function hasPassword(text: string) {
  return /\[e\d+ 비밀번호칸/.test(text)
}

function humanReason(text: string) {
  if (/보안\s?문자|자동\s?입력\s?방지|로봇|captcha/i.test(text)) return '로봇 확인(보안 문자)이 떴어요'
  if (/본인\s?인증|휴대폰\s?인증|인증\s?번호|2단계|추가\s?인증|OTP/i.test(text)) return '본인인증이 필요해요'
  return '직접 확인이 필요해요'
}
