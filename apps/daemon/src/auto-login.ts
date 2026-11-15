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
/** 로봇 확인: 로그인 화면에 떠 있으면 사람이 풀어야 한다 */
const CAPTCHA = /보안\s?문자|자동\s?입력\s?방지|로봇이 아닙니다|I'm not a robot|문자를 입력해/i
/** 로그인을 누른 뒤의 추가 인증 (로그인 화면의 "아이디 찾기(본인인증)" 같은 안내와 헷갈리지 않게 좁게) */
const STEP2 =
  /인증\s?번호를?\s?(입력|받|보내)|새로운\s?(기기|환경|브라우저)에서|2단계\s?인증|추가\s?인증이\s?필요|본인\s?확인이\s?필요|본인인증을\s?진행|OTP\s?(번호|입력)/i
const HUMAN = new RegExp(`${CAPTCHA.source}|${STEP2.source}`, 'i')
const WRONG =
  /(비밀번호|아이디|계정).{0,20}(잘못|틀|일치하지|확인해|올바르지|맞지 않)|등록되지 않은|incorrect|invalid (password|username|email)|wrong password/i

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 화면이 다 그려질 때까지 (글이 거의 없으면 조금씩 기다려 다시 읽는다) */
async function settled(snap: () => Promise<Snap>, wait: number): Promise<Snap> {
  let page = await snap()
  for (let i = 0; i < 4 && page.text.replace(/\s/g, '').length < 12; i++) {
    await sleep(Math.max(wait, 800))
    page = await snap()
  }
  return page
}

export interface ProbeResult {
  status: 'found' | 'human' | 'unknown' | 'signed-in'
  url: string
  /** 점검용: 확장이 로봇 확인으로 본 화면인지, 화면 글 앞부분 */
  captcha?: boolean
  sample?: string
  title?: string
  userField?: string
  passwordField?: string
  submit?: string
  clicks: string[]
}

/** 점검: 로그인 칸을 찾기만 하고 넣거나 누르지 않는다 (실제 사이트에서 찾을 수 있는지 보기) */
export async function probeLogin(
  browser: AutoLoginBrowser,
  input: Pick<AutoLoginInput, 'card' | 'url'>,
  opts: { wait?: number } = {},
): Promise<ProbeResult & { tabId: number }> {
  const wait = opts.wait ?? 2_000
  const snap = async (tabId: number) => (await browser.call('snapshot', { tabId, maxChars: 12_000 })) as Snap
  const opened = (await browser.call('open', { url: input.url }, 40_000)) as { tabId: number }
  const tabId = opened.tabId
  const clicks: string[] = []
  let page = await settled(() => snap(tabId), wait)
  if (looksSignedIn(input.card, page)) return { status: 'signed-in', url: page.url, clicks, tabId }
  let retried = false
  for (let i = 0; i < 3 && !hasPassword(page.text); i++) {
    const target = findLoginLink(page.text)
    if (!target) {
      // 화면이 아직 바뀌는 중일 수 있다 (다른 주소로 넘어가거나 늦게 그려지는 사이트): 한 번만 더 기다려 본다
      if (retried) break
      retried = true
      await sleep(Math.max(wait, 1_500))
      page = await settled(() => snap(tabId), wait)
      i--
      continue
    }
    clicks.push(target[1].name)
    await browser.call('click', { tabId, ref: target[0] }, 30_000).catch(() => undefined)
    await sleep(wait)
    page = await settled(() => snap(tabId), wait)
  }
  const base = {
    url: page.url,
    ...(page.title ? { title: page.title } : {}),
    clicks,
    tabId,
    captcha: Boolean(page.captcha),
    sample: page.text.slice(0, 1500),
  }
  // 로그인 화면에는 눈에 안 보이는 로봇 확인이 깔린 곳이 많다 (쿠팡·11번가). 칸이 보이면 그대로 간다
  if (CAPTCHA.test(page.text)) return { status: 'human', ...base }
  if (!hasPassword(page.text))
    return { status: page.captcha || HUMAN.test(page.text) ? 'human' : 'unknown', ...base }
  const f = loginFields(page.text)
  return {
    status: 'found',
    ...base,
    ...(f.user ? { userField: f.user[1].name } : {}),
    passwordField: f.password[1].name,
    ...(f.submit ? { submit: f.submit[1].name } : {}),
  }
}

type RefEntry = [string, { role: string; name: string }]

/** 간편 로그인·가입은 아이디·비밀번호 로그인이 아니다 */
const NOT_ID_LOGIN =
  /패스키|QR|간편|휴대폰|카카오|네이버|애플|구글|페이코|SNS|회원\s?가입|가입|비회원|kakao|naver|apple|google/i

function findLoginLink(text: string): RefEntry | undefined {
  const refs = ([...parseRefs(text)] as RefEntry[]).filter(
    ([, r]) =>
      (r.role === '링크' || r.role === '버튼') && r.name.trim().length <= 20 && !NOT_ID_LOGIN.test(r.name),
  )
  return (
    refs.find(([, r]) => LOGIN_WORD.test(r.name.trim())) ??
    refs.find(([, r]) => /(아이디|이메일|ID)\s?로그인/i.test(r.name)) ??
    // 로그인 방법 고르기 화면: 통신사·포털 자체 아이디 (U+ID, T아이디, KT ID…)
    refs.find(([, r]) =>
      /^(U\+\s?ID|MYLGID|T\s?아이디|KT\s?ID|통합\s?아이디|아이디|(이?메일|이메일)로\s?(시작하기|로그인))$/i.test(
        r.name.trim(),
      ),
    ) ??
    refs.find(([, r]) => LOGIN_LINK.test(r.name))
  )
}

function loginFields(text: string) {
  const order = [...parseRefs(text)] as RefEntry[]
  const pwIndex = order.findIndex(([, r]) => r.role === '비밀번호칸')
  const password = order[pwIndex] as RefEntry
  const before = order.slice(0, pwIndex).filter(([, r]) => r.role === '입력칸' || r.role === '검색칸')
  const user =
    before.findLast(([, r]) => USER_FIELD.test(r.name)) ??
    before.filter(([, r]) => r.role === '입력칸').at(-1)
  const after = order.slice(pwIndex + 1)
  const submit =
    after.find(([, r]) => r.role === '버튼' && LOGIN_WORD.test(r.name.trim())) ??
    after.find(([, r]) => r.role === '버튼' && LOGIN_LINK.test(r.name))
  return { user, password, submit }
}

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
  let page = await settled(() => snap(tabId), wait)
  if (looksSignedIn(input.card, page)) return { status: 'ok', tabId }
  let retried = false
  for (let i = 0; i < 3 && !hasPassword(page.text); i++) {
    const target = findLoginLink(page.text)
    if (!target) {
      // 화면이 아직 바뀌는 중일 수 있다 (다른 주소로 넘어가거나 늦게 그려지는 사이트): 한 번만 더 기다려 본다
      if (retried) break
      retried = true
      await sleep(Math.max(wait, 1_500))
      page = await settled(() => snap(tabId), wait)
      i--
      continue
    }
    await browser.call('click', { tabId, ref: target[0] }, 30_000).catch(() => undefined)
    await sleep(wait)
    page = await settled(() => snap(tabId), wait)
  }
  if (CAPTCHA.test(page.text)) return { status: 'human', tabId, reason: humanReason(page.text) }
  if (!hasPassword(page.text) && (page.captcha || STEP2.test(page.text)))
    return { status: 'human', tabId, reason: humanReason(page.text) }
  if (!hasPassword(page.text))
    return {
      status: 'unknown',
      tabId,
      message: '로그인 칸을 찾지 못했어요. 화면을 보면서 직접 로그인해 주세요.',
    }

  // 2) 칸 채우기 (확장이 주소를 다시 확인한다)
  const fields = loginFields(page.text)
  const pwRef = fields.password[0]
  const userRef = fields.user?.[0]
  const origin = new URL(page.url).origin
  const loginOrigin = origin
  if (userRef) await browser.call('fill', { tabId, ref: userRef, value: input.username, origin })
  await browser.call('fill', { tabId, ref: pwRef, value: input.password, origin, password: true })

  // 3) 로그인 누르기: 비밀번호 칸 뒤의 "로그인" 버튼, 없으면 Enter
  const submit = fields.submit
  if (submit) await browser.call('click', { tabId, ref: submit[0] }, 30_000).catch(() => undefined)
  else await browser.call('press', { tabId, key: 'Enter' }).catch(() => undefined)

  // 4) 결과 보기
  for (let i = 0; i < (opts.tries ?? 8); i++) {
    await sleep(wait)
    page = await snap(tabId).catch(() => page)
    if (looksSignedIn(input.card, page)) return { loginOrigin, status: 'ok', tabId }
    if (HUMAN.test(page.text) && !WRONG.test(page.text))
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
