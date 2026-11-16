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
  // 글이 거의 없거나 누를 것이 두세 개뿐이면 아직 그리는 중이다 (로그인 창을 늦게 띄우는 사이트)
  const thin = (p: Snap) =>
    p.text.replace(/\s/g, '').length < 12 ||
    ((p.text.match(/\[e\d+ /g)?.length ?? 0) < 3 && !/\[e\d+ (입력칸|비밀번호칸)/.test(p.text))
  for (let i = 0; i < 4 && thin(page); i++) {
    await sleep(Math.max(wait, 800))
    page = await snap()
  }
  return page
}

/** 첫 화면을 덮는 광고·공지 팝업 닫기 ("오늘은 그만 보기", "닫기"). 로그인 버튼이 그 아래에 깔려 눌리지 않는다 */
const POPUP_CLOSE =
  /^(닫기|팝업\s?닫기|close|오늘은?\s?그만\s?보기|오늘\s?하루\s?(동안\s?)?(보지|열지)\s?않기|다시\s?보지\s?않기|일주일간\s?보지\s?않기)$/i
async function closePopups(
  browser: AutoLoginBrowser,
  tabId: number,
  page: Snap,
  snap: (tabId: number) => Promise<Snap>,
  wait: number,
): Promise<Snap> {
  // "오늘은 그만 보기"가 있으면 그것부터 (다시 안 뜨게), 많아야 두 번
  for (let i = 0; i < 2; i++) {
    const refs = ([...parseRefs(page.text)] as RefEntry[]).filter(
      ([, r]) => (r.role === '버튼' || r.role === '링크') && POPUP_CLOSE.test(r.name.trim()),
    )
    const target = refs.find(([, r]) => /오늘|다시|일주일/.test(r.name)) ?? refs[0]
    if (!target) break
    await browser.call('click', { tabId, ref: target[0] }, 15_000).catch(() => undefined)
    await sleep(Math.min(wait, 800))
    page = await snap(tabId)
  }
  return page
}

export interface ProbeResult {
  /** 점검이 연 탭들 (닫을 때) */
  tabs?: number[]
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
  /** 지나온 로그인 화면들에 있던 간편 로그인 */
  social?: SocialProvider[]
}

/** 점검: 로그인 칸을 찾기만 하고 넣거나 누르지 않는다 (실제 사이트에서 찾을 수 있는지 보기) */
export async function probeLogin(
  browser: AutoLoginBrowser,
  input: Pick<AutoLoginInput, 'card' | 'url'>,
  opts: { wait?: number } = {},
): Promise<ProbeResult & { tabId: number }> {
  const wait = opts.wait ?? 2_500
  const snap = async (tabId: number) => (await browser.call('snapshot', { tabId, maxChars: 12_000 })) as Snap
  const opened = (await browser.call('open', { url: input.url }, 40_000)) as { tabId: number }
  let tabId = opened.tabId
  /** 연 탭들 (로그인이 새 창으로 열리면 늘어난다) */
  const tabs = [tabId]
  const clicks: string[] = []
  let page = await settled(() => snap(tabId), wait)
  if (looksSignedIn(input.card, page)) return { status: 'signed-in', url: page.url, clicks, tabId }
  if (!hasPassword(page.text)) page = await closePopups(browser, tabId, page, snap, wait)
  const social = new Set<SocialProvider>(socialProvidersIn(page.text))
  let retried = false
  const tried = new Set<string>()
  for (let i = 0; i < 4 && !hasPassword(page.text) && !twoStep(page.text); i++) {
    const target = findLoginLink(page.text, tried)
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
    tried.add(target[1].name.trim())
    // 로그인이 새 창(팝업)으로 열리면 그 창을 따라간다
    const clicked = (await browser.call('click', { tabId, ref: target[0] }, 30_000).catch(() => undefined)) as
      | { newTabId?: number }
      | undefined
    if (clicked?.newTabId) {
      tabId = clicked.newTabId
      tabs.push(tabId)
    }
    await sleep(wait)
    page = await settled(() => snap(tabId), wait)
    for (const p of socialProvidersIn(page.text)) social.add(p)
  }
  const base = {
    social: [...social],
    url: page.url,
    ...(page.title ? { title: page.title } : {}),
    clicks,
    tabId,
    tabs,
    captcha: Boolean(page.captcha),
    sample: page.text.slice(0, 1500),
  }
  // 로그인 화면에는 눈에 안 보이는 로봇 확인이 깔린 곳이 많다 (쿠팡·11번가). 칸이 보이면 그대로 간다
  if (CAPTCHA.test(page.text)) return { status: 'human', ...base }
  const two = twoStep(page.text)
  if (two)
    return { status: 'found', ...base, userField: two.user[1].name, submit: `${two.next[1].name} (두 단계)` }
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

/** 간편 로그인(소셜·패스키·QR)은 아이디·비밀번호 로그인이 아니다 */
const SOCIAL =
  /패스키|QR|간편|휴대폰|카카오|네이버|애플|구글|페이코|SNS|kakao|naver|apple|google|facebook|페이스북/i
/** 가입·비회원만 하는 링크 ("로그인/회원가입"처럼 로그인이 같이 있으면 괜찮다) */
const JOIN_ONLY = (name: string) =>
  (/가입|비회원/.test(name) && !/로그인|log ?in|sign ?in/i.test(name)) ||
  // 사업자·파트너·판매자 로그인은 사용자 계정이 아니다
  /파트너|사업자|판매자|셀러|기업\s?회원|partner|seller|business/i.test(name)

/** 로그인 방법 고르기 화면의 "아이디·이메일로 로그인" (소셜·가입 말고 우리가 채울 수 있는 방법) */
const ID_LOGIN =
  /^((이메일|아이디|ID|e-?mail|휴대폰\s?번호|통합\s?(아이디|계정)).{0,12}(로그인|계속하기|시작하기)|(이?메일|아이디)로\s?(로그인|시작하기|계속하기)|이메일|이메일\s?주소|메일|아이디|email|e-?mail\s?address)$/i

function findLoginLink(text: string, skip: ReadonlySet<string> = new Set()): RefEntry | undefined {
  const refs = ([...parseRefs(text)] as RefEntry[]).filter(
    ([, r]) =>
      (r.role === '링크' || r.role === '버튼') &&
      r.name.trim().length <= 24 &&
      // 이미 눌렀는데 화면이 그대로면 다른 걸 눌러 본다 (위쪽 "로그인/회원가입"만 계속 누르지 않게)
      !skip.has(r.name.trim()) &&
      // 아이디·비밀번호 찾기·재설정은 로그인 화면이 아니다
      !/찾기|잊으셨|재설정|forgot|reset/i.test(r.name) &&
      !SOCIAL.test(r.name) &&
      !JOIN_ONLY(r.name),
  )
  return (
    // 로그인 방법 고르기 화면: "이메일 로그인", "아이디로 로그인", "무신사 통합계정 … 로그인"
    refs.find(([, r]) => ID_LOGIN.test(r.name.trim())) ??
    refs.find(([, r]) => /(아이디|이메일|ID|통합\s?계정).{0,12}로그인/i.test(r.name)) ??
    // "서울시통합 계정으로 시작하기"처럼 앞에 이름이 붙은 통합 계정
    refs.find(([, r]) => /통합\s?(계정|아이디|회원).{0,12}(시작|로그인|계속)/.test(r.name)) ??
    refs.find(([, r]) => LOGIN_WORD.test(r.name.trim())) ??
    refs.find(([, r]) => /^로그인\s?[/·|]\s?회원\s?가입$/.test(r.name.trim())) ??
    // 로그인 방법 고르기 화면: 통신사·포털 자체 아이디 (U+ID, T아이디, KT ID…)
    refs.find(([, r]) =>
      /^(U\+\s?ID|MYLGID|T\s?아이디|KT\s?ID|통합\s?아이디|아이디)$/i.test(r.name.trim()),
    ) ??
    refs.find(([, r]) => LOGIN_LINK.test(r.name)) ??
    // 방법 고르기 화면의 "더 많은 옵션 보기"·"다른 방법으로 로그인" (이메일 로그인이 그 안에 있다)
    refs.find(([, r]) => /^(더\s?많은\s?(옵션|방법)|다른\s?방법)/.test(r.name.trim())) ??
    // 아이콘만 있는 사이트: 마이페이지·내 정보를 누르면 로그인 화면으로 간다
    refs.find(([, r]) =>
      /^(마이\s?페이지|마이|MY|내\s?정보|my\s?page|account|계정|sign in|signin)($|\s?[ㆍ·/|])/i.test(
        r.name.trim(),
      ),
    )
  )
}

const NEXT =
  /^(계속|다음|계속하기|진행|진행하기|이메일로 계속|continue|next|이메일로 계속하기|로그인 계속|이메일로 로그인|continue with email)$|^비밀번호로\s?로그인/i

/** 두 단계 로그인 (아이디·이메일 먼저 → 계속 → 비밀번호): 아이디 칸과 계속 버튼 */
function twoStep(text: string): { user: RefEntry; next: RefEntry } | undefined {
  if (hasPassword(text)) return undefined
  const refs = [...parseRefs(text)] as RefEntry[]
  const inputs = refs.filter(([, r]) => r.role === '입력칸')
  const user =
    refs.find(([, r]) => (r.role === '입력칸' || r.role === '검색칸') && USER_FIELD.test(r.name)) ??
    // 이름 없는 칸 하나뿐이고 화면이 이메일·아이디를 묻는다
    (inputs.length === 1 && /이메일|아이디|email/i.test(text) ? inputs[0] : undefined)
  const next = refs.find(([, r]) => r.role === '버튼' && NEXT.test(r.name.trim()))
  return user && next ? { user, next } : undefined
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
  let tabId = opened.tabId
  /** 연 탭들 (로그인이 새 창으로 열리면 늘어난다) */
  const tabs = [tabId]

  // 1) 로그인 화면 찾기: 비밀번호 칸이 보일 때까지 "로그인"을 누른다 (최대 3번)
  let page = await settled(() => snap(tabId), wait)
  if (looksSignedIn(input.card, page)) return { status: 'ok', tabId }
  if (!hasPassword(page.text)) page = await closePopups(browser, tabId, page, snap, wait)
  let retried = false
  const tried = new Set<string>()
  for (let i = 0; i < 4 && !hasPassword(page.text) && !twoStep(page.text); i++) {
    const target = findLoginLink(page.text, tried)
    if (!target) {
      // 화면이 아직 바뀌는 중일 수 있다 (다른 주소로 넘어가거나 늦게 그려지는 사이트): 한 번만 더 기다려 본다
      if (retried) break
      retried = true
      await sleep(Math.max(wait, 1_500))
      page = await settled(() => snap(tabId), wait)
      i--
      continue
    }
    tried.add(target[1].name.trim())
    // 로그인이 새 창(팝업)으로 열리면 그 창을 따라간다
    const clicked = (await browser.call('click', { tabId, ref: target[0] }, 30_000).catch(() => undefined)) as
      | { newTabId?: number }
      | undefined
    if (clicked?.newTabId) {
      tabId = clicked.newTabId
      tabs.push(tabId)
    }
    await sleep(wait)
    page = await settled(() => snap(tabId), wait)
  }
  if (CAPTCHA.test(page.text)) return { status: 'human', tabId, reason: humanReason(page.text) }
  // 두 단계: 아이디를 넣고 계속을 누르면 비밀번호 칸이 나온다
  const two = twoStep(page.text)
  if (two) {
    const origin0 = new URL(page.url).origin
    await browser.call('fill', { tabId, ref: two.user[0], value: input.username, origin: origin0 })
    await browser.call('click', { tabId, ref: two.next[0] }, 30_000).catch(() => undefined)
    await sleep(wait)
    page = await settled(() => snap(tabId), wait)
    if (hasPassword(page.text) && !loginFields(page.text).user) {
      // 비밀번호만 남은 화면: 비밀번호만 넣고 누른다
      const f = loginFields(page.text)
      const o = new URL(page.url).origin
      await browser.call('fill', {
        tabId,
        ref: f.password[0],
        value: input.password,
        origin: o,
        password: true,
      })
      if (f.submit) await browser.call('click', { tabId, ref: f.submit[0] }, 30_000).catch(() => undefined)
      else await browser.call('press', { tabId, key: 'Enter' }).catch(() => undefined)
      return watchResult(browser, input, tabId, o, wait, opts.tries ?? 8, snap)
    }
  }
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
  return watchResult(browser, input, tabId, loginOrigin, wait, opts.tries ?? 8, snap)
}

/** 로그인을 누른 뒤: 로그인됨 / 틀림 / 사람 단계 / 모름 */
async function watchResult(
  _browser: AutoLoginBrowser,
  input: AutoLoginInput,
  tabId: number,
  loginOrigin: string,
  wait: number,
  tries: number,
  snap: (tabId: number) => Promise<Snap>,
): Promise<AutoLoginResult> {
  let page: Snap | undefined
  for (let i = 0; i < tries; i++) {
    await sleep(wait)
    page = await snap(tabId).catch(() => page)
    if (!page) continue
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
    loginOrigin,
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

// ── 간편 로그인 (카카오·네이버·구글…) ─────────────────────────────

/** 간편 로그인 공급자: 사이트의 버튼 글자, 공급자 로그인 화면 주소 */
export const SOCIAL_PROVIDERS = {
  kakao: { label: '카카오', button: /카카오|kakao/i, host: /(^|\.)kakao\.com$/ },
  naver: { label: '네이버', button: /네이버|naver/i, host: /(^|\.)naver\.com$/ },
  google: { label: '구글', button: /구글|google/i, host: /(^|\.)google\.com$/ },
  apple: { label: 'Apple', button: /애플|apple/i, host: /(^|\.)apple\.com$/ },
  facebook: { label: '페이스북', button: /페이스북|facebook/i, host: /(^|\.)facebook\.com$/ },
  payco: { label: '페이코', button: /페이코|payco/i, host: /(^|\.)payco\.com$/ },
  toss: { label: '토스', button: /토스|toss/i, host: /(^|\.)toss\.im$/ },
} as const
export type SocialProvider = keyof typeof SOCIAL_PROVIDERS

/** 공급자 화면의 "동의하고 계속하기" 같은 버튼 (처음 한 번 묻는 정보 제공 동의) */
const CONSENT =
  /^(동의하고\s?(계속하기|시작하기|진행)|전체\s?동의하고\s?계속하기|계속하기|계속|확인|허용|허용하기|동의|동의하기|로그인|Continue|Allow|Agree|Agree and continue|Confirm)$/i

/** 사이트 로그인 화면에서 그 공급자 버튼 ("카카오로 시작하기", "네이버 로그인", 아이콘만 있는 "kakao") */
function findProviderButton(text: string, provider: SocialProvider): RefEntry | undefined {
  const p = SOCIAL_PROVIDERS[provider]
  const refs = ([...parseRefs(text)] as RefEntry[]).filter(
    ([, r]) =>
      (r.role === '링크' || r.role === '버튼') && p.button.test(r.name) && r.name.trim().length <= 30,
  )
  // 앱 내려받기·공식 계정 링크("kakao 채널", "google playstore")는 빼고, 로그인 말이 있는 것부터
  const ok = refs.filter(
    ([, r]) =>
      !/스토어|store|채널|channel|play|플레이|앱\s?다운|블로그|blog|youtube|유튜브/i.test(r.name) &&
      // 아래쪽 "facebook" 링크는 회사 페이스북 페이지다 (페이스북 로그인은 늘 "로그인·계속" 말이 붙는다)
      !(r.role === '링크' && /^(facebook|페이스북|instagram|인스타그램)$/i.test(r.name.trim())),
  )
  return (
    ok.find(([, r]) => /로그인|시작|계속|login|sign|continue/i.test(r.name)) ??
    ok.find(([, r]) => r.name.trim().length <= 12)
  )
}

export interface SocialLoginInput {
  card: AutoLoginInput['card']
  url: string
  provider: SocialProvider
  /** 공급자 로그인 화면이 나오면 쓸 금고 값 (그 공급자 주소의 항목). 없으면 사람에게 넘긴다 */
  creds(origin: string): Promise<{ username: string; password: string } | undefined>
}

/**
 * 간편 로그인으로 연결: 사이트 로그인 화면에서 공급자 버튼을 누르고,
 * 공급자 쪽이 이미 로그인돼 있으면 동의만 넘기고, 로그인 화면이면 금고 값을 넣는다(없으면 사람 차례).
 */
export async function socialLogin(
  browser: AutoLoginBrowser,
  input: SocialLoginInput,
  opts: { wait?: number; tries?: number } = {},
): Promise<AutoLoginResult> {
  const wait = opts.wait ?? 1_500
  const label = SOCIAL_PROVIDERS[input.provider].label
  const snap = async (tabId: number) => (await browser.call('snapshot', { tabId, maxChars: 12_000 })) as Snap
  const opened = (await browser.call('open', { url: input.url }, 40_000)) as { tabId: number }
  const siteTab = opened.tabId
  let page = await settled(() => snap(siteTab), wait)
  if (looksSignedIn(input.card, page)) return { status: 'ok', tabId: siteTab }
  page = await closePopups(browser, siteTab, page, snap, wait)

  // 1) 공급자 버튼 찾기: 없으면 로그인 화면으로 들어간다
  const tried = new Set<string>()
  let btn = findProviderButton(page.text, input.provider)
  for (let i = 0; i < 4 && !btn; i++) {
    const target = findLoginLink(page.text, tried)
    if (!target) break
    tried.add(target[1].name.trim())
    await browser.call('click', { tabId: siteTab, ref: target[0] }, 30_000).catch(() => undefined)
    await sleep(wait)
    page = await settled(() => snap(siteTab), wait)
    btn = findProviderButton(page.text, input.provider)
  }
  if (!btn)
    return {
      status: 'unknown',
      tabId: siteTab,
      message: `로그인 화면에서 ${label} 버튼을 찾지 못했어요. 화면을 보면서 직접 로그인해 주세요.`,
    }

  // 2) 공급자 버튼 → 새 창(팝업)이거나 같은 탭에서 공급자 화면으로 간다
  const clicked = (await browser
    .call('click', { tabId: siteTab, ref: btn[0] }, 30_000)
    .catch(() => undefined)) as { newTabId?: number } | undefined
  let providerTab = clicked?.newTabId ?? siteTab
  const filled = new Set<string>()
  const pressed = new Set<string>()

  // 3) 결과를 보면서 공급자 화면의 단계를 넘긴다
  for (let i = 0; i < (opts.tries ?? 14); i++) {
    await sleep(wait)
    const site = await snap(siteTab).catch(() => undefined)
    if (site && looksSignedIn(input.card, site)) {
      if (providerTab !== siteTab) await browser.call('close', { tabId: providerTab }).catch(() => undefined)
      return { status: 'ok', tabId: siteTab }
    }
    const p = await snap(providerTab).catch(() => undefined)
    if (!p) {
      // 팝업이 닫혔다: 사이트 탭에서 마저 본다
      providerTab = siteTab
      continue
    }
    const host = (() => {
      try {
        return new URL(p.url).hostname
      } catch {
        return ''
      }
    })()
    const onProvider = SOCIAL_PROVIDERS[input.provider].host.test(host)
    if (!onProvider) continue
    if (CAPTCHA.test(p.text) || p.captcha || STEP2.test(p.text))
      return { status: 'human', tabId: providerTab, reason: humanReason(p.text) }
    const origin = new URL(p.url).origin
    // 공급자 로그인 화면: 금고 값이 있으면 넣고, 없으면 사람 차례
    const two = twoStep(p.text)
    if (hasPassword(p.text) || two) {
      const creds = await input.creds(origin)
      if (!creds || filled.has(p.url))
        return {
          status: 'human',
          tabId: providerTab,
          reason: `${label} 로그인이 필요해요. 한 번 로그인해 두면 다음부터는 두리가 버튼만 눌러요`,
        }
      filled.add(p.url)
      if (two && !hasPassword(p.text)) {
        await browser.call('fill', { tabId: providerTab, ref: two.user[0], value: creds.username, origin })
        await browser.call('click', { tabId: providerTab, ref: two.next[0] }, 30_000).catch(() => undefined)
        continue
      }
      const f = loginFields(p.text)
      if (f.user)
        await browser.call('fill', { tabId: providerTab, ref: f.user[0], value: creds.username, origin })
      await browser.call('fill', {
        tabId: providerTab,
        ref: f.password[0],
        value: creds.password,
        origin,
        password: true,
      })
      if (f.submit)
        await browser.call('click', { tabId: providerTab, ref: f.submit[0] }, 30_000).catch(() => undefined)
      else await browser.call('press', { tabId: providerTab, key: 'Enter' }).catch(() => undefined)
      continue
    }
    if (WRONG.test(p.text))
      return {
        status: 'wrong',
        tabId: providerTab,
        message: `${label} 아이디나 비밀번호가 맞지 않는 것 같아요. 화면을 보고 확인해 주세요.`,
      }
    // 계정 고르기(구글): 이메일이 적힌 줄을 누른다
    const refs = [...parseRefs(p.text)] as RefEntry[]
    const account = refs.find(([, r]) => (r.role === '링크' || r.role === '버튼') && /@/.test(r.name))
    // 정보 제공 동의: "동의하고 계속하기"
    const consent = refs.find(([, r]) => r.role === '버튼' && CONSENT.test(r.name.trim()))
    const next = account ?? consent
    if (next && !pressed.has(`${p.url}|${next[1].name}`)) {
      pressed.add(`${p.url}|${next[1].name}`)
      await browser.call('click', { tabId: providerTab, ref: next[0] }, 30_000).catch(() => undefined)
    }
  }
  return {
    status: 'unknown',
    tabId: providerTab,
    message: `${label} 로그인을 마쳤는지 확인하지 못했어요. 화면을 보고 확인해 주세요.`,
  }
}

/** 점검용: 로그인 화면에 있는 간편 로그인 공급자 */
export function socialProvidersIn(text: string): SocialProvider[] {
  return (Object.keys(SOCIAL_PROVIDERS) as SocialProvider[]).filter((p) => findProviderButton(text, p))
}
