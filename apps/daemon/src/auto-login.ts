// 서비스 연결: 사용자가 로그인 카드에 넣은 아이디·비밀번호로 두리 본체가 직접 로그인한다 (AI를 거치지 않는다).
// 1) 사이트를 열고 로그인 화면을 찾는다 (비밀번호 칸이 없으면 "로그인" 링크·버튼을 누른다)
// 2) 금고 값을 칸에 넣고 로그인 버튼(없으면 Enter)을 누른다
// 3) 화면 글자로 결과를 본다: 로그인됨 / 로봇 확인·본인인증(사람이 해야 함) / 아이디·비밀번호 틀림 / 모름
import type { ConnectStep } from '@dool2/protocol'
import type { ConnectCard } from '@dool2/protocol/connect'
import { parseRefs } from './browser-tools.js'
import { looksSignedIn } from './connect-watch.js'

export interface AutoLoginBrowser {
  call(method: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

export interface AutoLoginInput {
  card: Pick<ConnectCard, 'id' | 'name' | 'signedIn'> & { site?: string; login?: string }
  url: string
  username: string
  password: string
  ask?: LoginAsk
  /** 지금 하는 단계 (폰 연결 카드에 보여 준다). 값(아이디·비밀번호)은 넣지 않는다 */
  step?: StepFn
  /** 지금 로그인하고 있는 탭 (폰 연결 카드에 그 화면을 보여 준다). 새 창으로 넘어가면 다시 부른다 */
  onTab?: (tabId: number) => void
}

/** 사람에게 넘기는 대신 폰 입력 화면으로 묻기 (원격 화면보다 빠르고 편하다) */
export interface LoginAsk {
  /** 공급자 계정(카카오 등) 아이디·비밀번호를 폰에서 받아 금고에 넣고 돌려준다 */
  credentials?(
    origin: string,
    site: string,
    tabId: number,
  ): Promise<{ username: string; password: string } | undefined>
  /** 화면이 묻는 것 (인증번호·휴대폰 번호) */
  info?(req: {
    field: 'otp' | 'tel' | 'text' | 'choice'
    label: string
    hint?: string
    host: string
    options?: string[]
  }): Promise<string | undefined>
  /** 공급자 계정이 여럿일 때 전에 고른 계정(화면에 보이는 글) */
  account?: {
    get(provider: SocialProvider): string | undefined
    set(provider: SocialProvider, label: string): void
  }
  /**
   * 사용자가 "내 계정"이라고 확인해 준 공급자 계정 (동의 화면에 보이는 글: 카카오 "f***@gmail.com").
   * 처음 보는 계정이면 동의를 누르기 전에 한 번 묻는다 (엉뚱한 계정으로 가입·연동되지 않게)
   */
  known?: {
    has(provider: SocialProvider, label: string): boolean
    add(provider: SocialProvider, label: string): void
  }
}

/**
 * 같은 계정인지: 같은 글이거나, 한쪽이 가린 이메일(f***@gmail.com)이면 앞 글자·도메인이 맞는지.
 * 카카오 동의 화면은 같은 계정을 어떤 때는 가려서, 어떤 때는 전부 보여 준다 (실측 2026-11-19)
 */
export function sameAccount(a: string, b: string): boolean {
  const x = a.trim().toLowerCase()
  const y = b.trim().toLowerCase()
  if (x === y) return true
  const [xu = '', xd = ''] = x.split('@')
  const [yu = '', yd = ''] = y.split('@')
  if (!xd || xd !== yd || !(xu.includes('*') || yu.includes('*'))) return false
  const head = (u: string) => u.replace(/\*.*$/, '')
  const [masked, full] = xu.includes('*') ? [xu, yu] : [yu, xu]
  if (full.includes('*')) return head(masked) === head(full) && head(masked).length > 0
  return head(masked).length > 0 && full.startsWith(head(masked))
}

/**
 * 공급자 계정 화면에서 지금 로그인된 계정 (실측 2026-11-19):
 * 카카오 accounts.kakao.com "felix…@gmail.com 계정 정보로 이동", 네이버 첫 화면 "wwd님", 구글 "Google 계정: 이름 (메일)"
 */
export function providerAccountIn(provider: SocialProvider, text: string): string | undefined {
  if (provider === 'kakao') return /"([^"\s]+@[^"\s]+) 계정 정보로 이동"/.exec(text)?.[1]
  if (provider === 'naver') return /\[e\d+ (?:링크|버튼) "([^"\s]{2,30})님"\]/.exec(text)?.[1]
  if (provider === 'google')
    return /(?:Google 계정|Google Account): [^"(]*\(([^)\s]+@[^)\s]+)\)/.exec(text)?.[1]
  return undefined
}

/**
 * 체크된 칸 ("[e5 체크박스 \"[필수] 개인정보 제 3자 제공 동의\" 선택됨]"). 칸 이름 안의 ']'([필수])를 건너뛰고
 * 따옴표 뒤의 '선택됨'을 본다: 예전 식은 이름 안의 ']'에서 끊겨 체크된 칸을 안 된 것으로 보고 다시 눌러 풀었다
 * (실측 네이버 동의: 29CM·에어비앤비·마이리얼트립·아시아나·이스타)
 */
const CHECKED_RE = /\[(e\d+) 체크박스 "(?:[^"\\]|\\.)*"[^\]"]*선택됨\]/g
export function checkedRefs(text: string): Set<string> {
  return new Set([...text.matchAll(CHECKED_RE)].map((m) => m[1] as string))
}

/** 로그인 화면의 '로그인 상태 유지' 칸 (아직 안 켜져 있으면 그 표시) */
export function keepSignedIn(text: string): string | undefined {
  const m =
    /\[(e\d+) 체크박스 "(?:로그인\s?상태\s?유지|자동\s?로그인|Keep me (?:signed|logged) in|Stay signed in)[^"]*"([^\]]*)\]/i.exec(
      text,
    )
  return m && !/선택됨/.test(m[2] ?? '') ? m[1] : undefined
}

/** 공급자 동의 화면에 보이는 "지금 로그인된 계정" (카카오: "로그인된 계정 f***@gmail.com", 구글 한 계정: 이메일) */
export function providerAccountOn(text: string): string | undefined {
  const kakao = /로그인된\s?계정\s*([^\s[\]"]+@[^\s[\]"]+)/.exec(text)
  if (kakao) return kakao[1]
  const mail = /(?:^|[\s"(])([\w.*+-]+@[\w-]+(?:\.[\w-]+)+)/.exec(said(text))
  return mail?.[1]
}

/** 인증번호 칸 */
const CODE_FIELD =
  /인증\s?번호|인증\s?코드|보안\s?코드|확인\s?코드|승인\s?번호|OTP|verification|one[-\s]?time|\bcode\b/i
const TEL_FIELD = /휴대폰\s?번호|휴대전화|전화\s?번호|phone/i
const ANSWER_SUBMIT =
  /^(확인|인증|인증하기|확인하기|인증\s?완료|다음|계속|계속하기|로그인|제출|완료|submit|verify|continue|next|confirm|done)$/i

/**
 * 화면이 인증번호·휴대폰 번호를 물으면 폰 입력 화면으로 받아 그 칸에 넣고 확인을 누른다.
 * done: 넣고 눌렀다 / none: 물을 칸이 없다 / cancel: 사용자가 안 넣었다
 */
async function answerOnScreen(
  browser: AutoLoginBrowser,
  tabId: number,
  page: Snap,
  ask: LoginAsk | undefined,
  asked: Set<string>,
): Promise<'done' | 'none' | 'cancel'> {
  if (!ask?.info) return 'none'
  const refs = [...parseRefs(page.text)] as RefEntry[]
  const inputs = refs.filter(([, r]) => r.role === '입력칸' && !/값="/.test(r.name))
  const code = inputs.find(([, r]) => CODE_FIELD.test(r.name))
  const tel = inputs.find(([, r]) => TEL_FIELD.test(r.name))
  const target = code ?? tel
  if (!target) return 'none'
  const key = `${page.url}|${target[1].name}`
  if (asked.has(key)) return 'none'
  asked.add(key)
  // 화면 안내 한 줄 ("카카오톡으로 보낸 6자리를 넣어 주세요")
  const hint = page.text
    .split('\n')
    // 화면 읽기의 표시(제목 #, 목록 -, [e3 버튼 …])는 떼고 사람 말만
    .map((l) =>
      l
        .replace(/\[[^\]]*\]/g, '')
        .replace(/^\s*(#+|[-*•]|\d+\.)\s*/, '')
        .trim(),
    )
    .find((l) => l.length >= 8 && l.length <= 80 && /인증|번호|보냈|문자|입력/.test(l))
  const host = (() => {
    try {
      return new URL(page.url).hostname
    } catch {
      return ''
    }
  })()
  const value = await ask.info({
    field: code ? 'otp' : 'tel',
    label: target[1].name || (code ? '인증번호' : '휴대폰 번호'),
    ...(hint ? { hint } : {}),
    host,
  })
  if (!value) return 'cancel'
  // 사람이 넣는 동안 화면을 다시 읽었을 수 있다(폰 원격 화면·일하는 화면): 그때 표시(e12 같은 번호)가 바뀌므로
  // 넣기 전·누르기 전에 화면을 새로 읽어 같은 이름의 칸·버튼을 다시 찾는다 (옛 번호로 누르면 조용히 실패했다)
  const fresh = async () => {
    const now = (await browser.call('snapshot', { tabId, maxChars: 12_000 }).catch(() => undefined)) as
      | Snap
      | undefined
    return now ? ([...parseRefs(now.text)] as RefEntry[]) : refs
  }
  let cur = await fresh()
  const field = cur.find(([, r]) => r.role === '입력칸' && r.name === target[1].name) ?? target
  await browser.call('type', { tabId, ref: field[0], text: value })
  cur = await fresh()
  const at = cur.findIndex(([, r]) => r.role === '입력칸' && r.name.startsWith(target[1].name))
  const after = at >= 0 ? cur.slice(at + 1) : cur
  const submit = after.find(([, r]) => r.role === '버튼' && ANSWER_SUBMIT.test(r.name.trim()))
  const clicked = submit
    ? await browser.call('click', { tabId, ref: submit[0] }, 30_000).then(
        () => true,
        () => false,
      )
    : false
  if (!clicked) await browser.call('press', { tabId, key: 'Enter' }).catch(() => undefined)
  return 'done'
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
const CAPTCHA =
  /보안\s?문자|자동\s?입력\s?방지|로봇이 아닙니다|I'm not a robot|문자를 입력해|아래\s?문제에\s?답해|DKAPTCHA|지도에서\s?.{0,8}눌러/i
/** 로그인을 누른 뒤의 추가 인증 (로그인 화면의 "아이디 찾기(본인인증)" 같은 안내와 헷갈리지 않게 좁게) */
const STEP2 =
  /인증\s?번호를?\s?(입력|받|보내)|(확인|로그인|보안)\s?코드를?\s?(입력|받|보냈|보내)|새로운\s?(기기|환경|브라우저)에서|2단계\s?인증|추가\s?인증이\s?필요|본인\s?확인이\s?필요|본인인증을\s?진행|OTP\s?(번호|입력)/i
const HUMAN = new RegExp(`${CAPTCHA.source}|${STEP2.source}`, 'i')
/**
 * 화면이 사람에게 하는 말만 (링크 글자 뺌). 추가 인증·틀림·로봇 확인·앱 승인은 안내 문장·칸·버튼으로 나온다.
 * 링크는 목록의 제목일 때가 많다: 네이버 메일 받은메일함의 "새로운 환경에서 로그인 되었습니다." 메일 제목을
 * 2단계 인증 화면으로 읽어 이미 로그인된 메일함을 실패로 끝냈다 (2026-11-19 실측)
 */
export function said(text: string): string {
  return text.replace(/\[e\d+ 링크 "[^"]*"\]/g, '')
}
/**
 * 휴대폰 앱에서 승인을 누르라는 화면 (카카오톡 로그인 확인, 네이버 앱 2단계 인증, 구글 "휴대전화를 확인하세요", 토스 푸시).
 * 칸이 없어 넣을 것도 없다: 사용자에게 알리고 화면이 바뀔 때까지 기다린다
 */
const APP_CONFIRM =
  /(카카오톡|네이버\s?앱|토스\s?앱|앱|휴대\s?전화|휴대폰|기기)(에서|으로|로)\s?.{0,14}(확인|승인|인증|허용|눌러|탭)|알림을\s?(보냈|확인|탭|눌러)|푸시\s?(알림|인증)|check your phone|tap yes|approve (the |this )?sign.?in|로그인\s?(요청|확인)을?\s?(보냈|확인해)/i
/** "이 브라우저에서 2단계 인증 사용 안 함"·"이 기기 기억하기" 같은 칸 */
const REMEMBER_BROWSER =
  /(이\s?(브라우저|기기|PC|컴퓨터)에서|이\s?(기기|브라우저)를?\s?기억).{0,16}(사용\s?안\s?함|묻지\s?않|기억|건너뛰)|다시\s?묻지\s?않|don'?t ask again|remember (this )?(device|browser)/i
/** 승인을 기다리는 최대 시간 */
export const CONFIRM_WAIT_MS = 3 * 60_000

export type StepFn = (text: string, ask?: ConnectStep['ask']) => void

/** 어느 앱에서 누르면 되는지 (화면 글로 짐작) */
function confirmWhere(text: string): string {
  if (/카카오톡|kakaotalk/i.test(text)) return '카카오톡'
  if (/네이버\s?앱|naver app/i.test(text)) return '네이버 앱'
  if (/토스/i.test(text)) return '토스 앱'
  if (/google|구글|휴대\s?전화를\s?확인|check your phone/i.test(text)) return '휴대전화'
  return '휴대폰 앱'
}

/**
 * 앱 승인 화면이면 카드에 "○○에서 확인을 눌러 주세요"를 띄우고 화면이 바뀔 때까지(최대 3분) 기다린다.
 * 바뀌면 'moved', 시간이 지나면 'timeout', 승인 화면이 아니면 'none'
 */
async function waitConfirm(
  page: Snap,
  tabId: number,
  snap: (tabId: number) => Promise<Snap>,
  step: StepFn | undefined,
  wait: number,
  limitMs = CONFIRM_WAIT_MS,
): Promise<'none' | 'moved' | 'timeout'> {
  if (hasPassword(page.text) || !APP_CONFIRM.test(said(page.text))) return 'none'
  const where = confirmWhere(page.text)
  step?.(`${where}에서 확인을 눌러 주세요`, {
    kind: 'confirm',
    id: String(tabId),
    label: '화면 보기',
    detail: `${where}에 온 로그인 확인을 눌러 주시면 두리가 이어서 해요`,
  })
  const until = Date.now() + limitMs
  while (Date.now() < until) {
    await sleep(Math.max(wait, 2_000))
    const now = await snap(tabId).catch(() => undefined)
    if (now && !APP_CONFIRM.test(said(now.text))) {
      step?.('확인됐어요, 이어서 하는 중')
      return 'moved'
    }
  }
  return 'timeout'
}
const WRONG =
  /(비밀번호|아이디|계정).{0,20}(잘못|틀|일치하지|확인해|올바르지|맞지 않)|등록되지 않은|incorrect|invalid (password|username|email)|wrong password/i

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 화면이 다 그려질 때까지 (글이 거의 없으면 조금씩 기다려 다시 읽는다) */
async function settled(snap: () => Promise<Snap>, wait: number): Promise<Snap> {
  let page = await snap()
  // 글이 거의 없거나 누를 것이 두세 개뿐이면 아직 그리는 중이다 (로그인 창을 늦게 띄우는 사이트)
  const fields = (p: Snap) => /\[e\d+ (입력칸|비밀번호칸)/.test(p.text)
  // 로그인 주소인데 입력칸이 하나도 없으면 아직 본문을 그리는 중이다 (KT: 바닥글만 먼저 그려진다)
  const loginPath = (p: Snap) => {
    try {
      return /log-?in|sign-?in|auth|member|account/i.test(new URL(p.url).pathname)
    } catch {
      return false
    }
  }
  const thin = (p: Snap) =>
    p.text.replace(/\s/g, '').length < 12 ||
    // 이름 있는 것이 세 개 안 되면 아직 껍데기만 그렸다 (캐치테이블: 이름 없는 링크 넷만 먼저 뜬다)
    ((p.text.match(/\[e\d+ [^\]"]*"[^"]+"/g)?.length ?? 0) < 3 && !fields(p)) ||
    // 간편 로그인만 있는 화면("카카오로 시작")은 칸이 없어도 다 그려진 것이다.
    // 위쪽 메뉴의 "로그인" 버튼, 화면 안 액자(구글 버튼)는 본문이 그려졌다는 뜻이 아니다
    (loginPath(p) &&
      !fields(p) &&
      !/\[e\d+ (버튼|링크) "[^"]*(카카오|네이버|구글|애플|apple|google|kakao|naver|휴대폰\s?번호)[^"]*(로그인|시작|계속|login|sign|continue)/i.test(
        p.text.split('## 화면 안 액자')[0] ?? '',
      ))
  for (let i = 0; i < 4 && thin(page); i++) {
    await sleep(Math.max(wait, 800))
    page = await snap()
  }
  return page
}

/** 첫 화면을 덮는 광고·공지 팝업 닫기 ("오늘은 그만 보기", "닫기"). 로그인 버튼이 그 아래에 깔려 눌리지 않는다 */
const POPUP_CLOSE =
  /^(닫기|팝업\s?닫기|close|오늘은?\s?그만\s?보기|오늘\s?하루\s?(동안\s?)?(보지|열지)\s?않기|다시\s?보지\s?않기|일주일간\s?보지\s?않기)$/i
const hasPopup = (text: string) =>
  ([...parseRefs(text)] as RefEntry[]).some(
    ([, r]) => (r.role === '버튼' || r.role === '링크') && POPUP_CLOSE.test(r.name.trim()),
  )
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
  // 간편 로그인 공급자 화면에 와 버렸으면 칸이 있어도 이 서비스 로그인 칸이 아니다
  if (providerPage(page.url, input.card)) return { status: 'unknown', ...base }
  // 로그인 화면에는 눈에 안 보이는 로봇 확인이 깔린 곳이 많다 (쿠팡·11번가). 칸이 보이면 그대로 간다
  if (CAPTCHA.test(said(page.text))) return { status: 'human', ...base }
  const two = twoStep(page.text)
  if (two)
    return { status: 'found', ...base, userField: two.user[1].name, submit: `${two.next[1].name} (두 단계)` }
  if (!hasPassword(page.text))
    return { status: page.captcha || HUMAN.test(said(page.text)) ? 'human' : 'unknown', ...base }
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

/**
 * 지금 화면이 다른 회사 간편 로그인(네이버·카카오·구글…) 화면인가.
 * 아이디·비밀번호 연결 중에 여기로 오면 그 서비스 아이디를 공급자 칸에 넣게 된다 — 절대 넣지 않는다
 */
function providerPage(url: string, card: { site?: string; login?: string }): string | undefined {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return undefined
  }
  for (const p of Object.values(SOCIAL_PROVIDERS)) {
    if (!p.host.test(host)) continue
    // 네이버 연결 카드가 네이버 로그인 화면에 있는 건 괜찮다
    if (card.site && p.host.test(card.site.replace(/^www\./, ''))) return undefined
    // 그 공급자 계정이 곧 이 서비스 아이디인 곳 (티켓링크 = PAYCO 아이디)
    if (card.login && p.button.test(card.login)) return undefined
    return p.label
  }
  return undefined
}

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
  /^(계속|다음|계속하기|진행|진행하기|이메일로 계속|continue|next|이메일로 계속하기|로그인 계속|이메일로 로그인|continue with email)$|^비밀번호로\s?로그인|^(이메일|아이디)\s?(계정)?으?로\s?계속(하기)?$/i

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
  const step = input.step ?? (() => {})
  step(`${input.card.name} 여는 중`)
  const opened = (await browser.call('open', { url: input.url }, 40_000)) as { tabId: number }
  let tabId = opened.tabId
  input.onTab?.(tabId)
  /** 연 탭들 (로그인이 새 창으로 열리면 늘어난다) */
  const tabs = [tabId]

  // 1) 로그인 화면 찾기: 비밀번호 칸이 보일 때까지 "로그인"을 누른다 (최대 3번)
  let page = await settled(() => snap(tabId), wait)
  if (looksSignedIn(input.card, page)) return { status: 'ok', tabId }
  if (!hasPassword(page.text)) {
    step('로그인 화면 찾는 중')
    page = await closePopups(browser, tabId, page, snap, wait)
  }
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
    step(`"${target[1].name.trim().slice(0, 20)}" 누르는 중`)
    // 로그인이 새 창(팝업)으로 열리면 그 창을 따라간다
    const clicked = (await browser.call('click', { tabId, ref: target[0] }, 30_000).catch(() => undefined)) as
      | { newTabId?: number }
      | undefined
    if (clicked?.newTabId) {
      tabId = clicked.newTabId
      tabs.push(tabId)
      input.onTab?.(tabId)
    }
    await sleep(wait)
    page = await settled(() => snap(tabId), wait)
  }
  const other = providerPage(page.url, input.card)
  if (other)
    return {
      status: 'unknown',
      tabId,
      message: `${other} 간편 로그인 화면으로 넘어가서 멈췄어요. ${other}로 연결하거나 화면을 보며 직접 해 주세요.`,
    }
  if (CAPTCHA.test(said(page.text))) return { status: 'human', tabId, reason: humanReason(page.text) }
  // 두 단계: 아이디를 넣고 계속을 누르면 비밀번호 칸이 나온다
  const two = twoStep(page.text)
  if (two) {
    const origin0 = new URL(page.url).origin
    step('아이디 넣는 중')
    await browser.call('fill', { tabId, ref: two.user[0], value: input.username, origin: origin0 })
    await browser.call('click', { tabId, ref: two.next[0] }, 30_000).catch(() => undefined)
    await sleep(wait)
    page = await settled(() => snap(tabId), wait)
    if (hasPassword(page.text) && !loginFields(page.text).user) {
      // 비밀번호만 남은 화면: 비밀번호만 넣고 누른다
      const f = loginFields(page.text)
      const o = new URL(page.url).origin
      step('비밀번호 넣고 로그인 누르는 중')
      await browser.call('fill', {
        tabId,
        ref: f.password[0],
        value: input.password,
        origin: o,
        password: true,
      })
      if (f.submit) await browser.call('click', { tabId, ref: f.submit[0] }, 30_000).catch(() => undefined)
      else await browser.call('press', { tabId, key: 'Enter' }).catch(() => undefined)
      step('로그인됐는지 확인하는 중')
      return watchResult(browser, input, tabId, o, wait, opts.tries ?? 8, snap)
    }
  }
  if (!hasPassword(page.text) && (page.captcha || STEP2.test(said(page.text))))
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
  step('아이디·비밀번호 넣는 중')
  if (userRef) await browser.call('fill', { tabId, ref: userRef, value: input.username, origin })
  await browser.call('fill', { tabId, ref: pwRef, value: input.password, origin, password: true })

  // 3) 로그인 누르기: 비밀번호 칸 뒤의 "로그인" 버튼, 없으면 Enter
  step('로그인 누르는 중')
  const submit = fields.submit
  if (submit) await browser.call('click', { tabId, ref: submit[0] }, 30_000).catch(() => undefined)
  else await browser.call('press', { tabId, key: 'Enter' }).catch(() => undefined)

  // 4) 결과 보기
  step('로그인됐는지 확인하는 중')
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
  const asked = new Set<string>()
  /** 인증번호를 넣고 확인을 누른 뒤 화면이 바뀌기를 기다리는 동안 (같은 화면이 잠깐 더 보인다) */
  let grace = 0
  for (let i = 0; i < tries; i++) {
    await sleep(wait)
    page = await snap(tabId).catch(() => page)
    if (!page) continue
    if (looksSignedIn(input.card, page, { sawEntry: true })) return { loginOrigin, status: 'ok', tabId }
    // 휴대폰 앱에서 승인하라는 화면: 카드에 알리고 기다린다 (넣을 칸이 없다)
    const confirm = await waitConfirm(page, tabId, snap, input.step, wait)
    if (confirm === 'moved') {
      i = Math.max(0, i - 2)
      continue
    }
    if (confirm === 'timeout')
      return {
        loginOrigin,
        status: 'human',
        tabId,
        reason: `${confirmWhere(page.text)}에서 확인을 아직 기다리고 있어요. 확인을 누르시면 두리가 이어서 연결해요`,
      }
    // 휴면 계정 깨우기 (아이디로 로그인한 뒤에도 같은 화면이 나온다)
    const dormant = dormantScreen(page.text)
    if (dormant?.kind === 'human')
      return {
        loginOrigin,
        status: 'human',
        tabId,
        reason: `${input.card.name} 계정이 오래 쓰지 않아 쉬고 있어요. 다시 쓰려면 ${dormant.why}이 필요해요`,
      }
    if (dormant && !asked.has(`${page.url}|dormant`)) {
      asked.add(`${page.url}|dormant`)
      input.step?.(`오래 쉬던 ${input.card.name} 계정 깨우는 중`)
      for (const ref of dormant.required)
        await _browser.call('click', { tabId, ref }, 15_000).catch(() => undefined)
      await _browser.call('click', { tabId, ref: dormant.submit }, 30_000).catch(() => undefined)
      i = Math.max(0, i - 2)
      continue
    }
    if (STEP2.test(said(page.text)) && !CAPTCHA.test(said(page.text)) && !WRONG.test(said(page.text))) {
      // 인증번호를 묻는 화면: 폰 입력 화면으로 받아 넣고 계속 본다
      input.step?.('인증번호를 기다리는 중')
      const a = await answerOnScreen(_browser, tabId, page, input.ask, asked)
      if (a === 'done') {
        grace = 3
        i = Math.max(0, i - 2)
        continue
      }
      if (grace-- > 0) continue
    }
    if (HUMAN.test(said(page.text)) && !WRONG.test(said(page.text)))
      return { loginOrigin, status: 'human', tabId, reason: humanReason(page.text) }
    if (WRONG.test(said(page.text)))
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

/**
 * 본인인증 창(토스·PASS·휴대폰 인증 등: 이름·휴대폰 번호·생년월일을 넣고 인증 앱으로 승인)이면
 * 무엇을 하면 되는지 한 문장으로. 아니면 undefined
 */
export function certScreen(text: string): string | undefined {
  const t = text.replace(/\s+/g, ' ')
  const toss = /토스로\s?인증|auth\.cert\.toss|토스\s?앱에서/.test(t)
  const pass = /\bPASS\b|패스\s?앱|통신사\s?인증/.test(t)
  const certFields =
    /(이름|성명).{0,30}(휴대폰|휴대전화|전화)\s?번호.{0,30}(생년월일|주민)|본인\s?확인을?\s?위해.{0,20}(휴대폰|번호)/.test(
      t,
    )
  const certWord = /본인\s?인증|본인\s?확인|휴대폰\s?인증|휴대전화\s?인증|간편\s?인증/.test(t)
  if (!toss && !pass && !certFields && !(certWord && /인증\s?(하기|요청|받기)/.test(t))) return undefined
  const app = toss ? '토스' : pass ? 'PASS(통신사)' : '인증'
  return `본인인증 창이에요. 이름·휴대폰 번호·생년월일을 넣고 [인증하기]를 누른 뒤, ${app} 앱 알림에서 승인해 주시면 두리가 이어서 할게요`
}

function humanReason(text: string) {
  if (/보안\s?문자|자동\s?입력\s?방지|로봇|captcha|문제에\s?답해|지도에서/i.test(text))
    return '로봇 확인(보안 문자)이 떴어요'
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
// 페이스북은 "○○님으로 계속"·"Continue as ○○"처럼 사용자 이름이 들어간다 (실측 예스24)
const CONSENT =
  /^((동의|확인)하고\s?(계속하기|계속|시작하기|진행(하기)?)|전체\s?동의하고\s?계속하기|계속하기|계속|확인|허용|허용하기|동의|동의하기|로그인|Continue|Allow|Agree|Agree and continue|Confirm|.{1,30}(?:님)?(?:으로|로)\s?계속(?:하기)?|Continue as .{1,30})$/i

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
      !/스토어|store|채널|channel|play|플레이|앱\s?다운|블로그|blog|youtube|유튜브|클립|clip|카페|포스트|naver\s?tv|네이버\s?tv/i.test(
        r.name,
      ) &&
      // 아래쪽 "facebook" 링크는 회사 페이스북 페이지다 (페이스북 로그인은 늘 "로그인·계속" 말이 붙는다)
      !(r.role === '링크' && /^(facebook|페이스북|instagram|인스타그램)$/i.test(r.name.trim())),
  )
  return (
    ok.find(([, r]) => /로그인|시작|계속|login|sign|continue/i.test(r.name)) ??
    // 말 없이 공급자 이름만 있는 버튼("kakao", "네이버"). "SSG 페이스북"처럼 앞에 다른 말이 붙은 건 회사 계정 링크다
    ok.find(
      ([, r]) =>
        r.name
          .trim()
          .replace(p.button, '')
          .replace(/[\s·|-]/g, '').length <= 2,
    )
  )
}

export interface SocialLoginInput {
  card: AutoLoginInput['card']
  url: string
  provider: SocialProvider
  /** 공급자 로그인 화면이 나오면 쓸 금고 값 (그 공급자 주소의 항목). 없으면 폰에 묻고, 그래도 없으면 사람에게 */
  creds(origin: string): Promise<{ username: string; password: string } | undefined>
  ask?: LoginAsk
  step?: StepFn
  onTab?: (tabId: number) => void
  /**
   * 연결된 회원이 없을 때 간편 가입까지 해도 되는지. 이 사이트에 이미 되는 계정(다른 간편 로그인·금고 아이디)이 있으면
   * 새로 가입하면 같은 사이트에 계정이 둘이 된다: 그땐 가입하지 않고 사람에게 알린다
   */
  join?: boolean
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
  const step = input.step ?? (() => {})
  step(`${input.card.name} 여는 중`)
  const opened = (await browser.call('open', { url: input.url }, 40_000)) as { tabId: number }
  const siteTab = opened.tabId
  input.onTab?.(siteTab)
  let page = await settled(() => snap(siteTab), wait)
  if (looksSignedIn(input.card, page)) return { status: 'ok', tabId: siteTab }
  step(`${label} 로그인 버튼 찾는 중`)
  page = await closePopups(browser, siteTab, page, snap, wait)

  // 1) 공급자 버튼 찾기: 없으면 로그인 화면으로 들어간다
  const tried = new Set<string>()
  let btn = findProviderButton(page.text, input.provider)
  for (let i = 0, late = 0; i < 4 && !btn; i++) {
    const target = findLoginLink(page.text, tried)
    if (!target) {
      // 아래쪽 메뉴(MY)를 늦게 그리는 사이트: 조금 기다렸다 다시 본다 (캐치테이블)
      if (late++ >= 3) break
      await sleep(wait)
      page = await snap(siteTab)
      btn = findProviderButton(page.text, input.provider)
      i--
      continue
    }
    tried.add(target[1].name.trim())
    const before = page.url
    await browser.call('click', { tabId: siteTab, ref: target[0] }, 30_000).catch(() => undefined)
    await sleep(wait)
    page = await settled(() => snap(siteTab), wait)
    btn = findProviderButton(page.text, input.provider)
    // 누르는 순간 광고 팝업이 떠서 클릭을 가로챘다: 팝업을 닫고 같은 링크를 한 번 더 누른다
    if (!btn && page.url === before && hasPopup(page.text)) {
      page = await closePopups(browser, siteTab, page, snap, wait)
      tried.delete(target[1].name.trim())
    }
  }
  if (!btn)
    return {
      status: 'unknown',
      tabId: siteTab,
      message: `로그인 화면에서 ${label} 버튼을 찾지 못했어요. 화면을 보면서 직접 로그인해 주세요.`,
    }

  // 2) 공급자 버튼 → 새 창(팝업)이거나 같은 탭에서 공급자 화면으로 간다
  step(`${label} 로그인 누르는 중`)
  const clicked = (await browser
    .call('click', { tabId: siteTab, ref: btn[0] }, 30_000)
    .catch(() => undefined)) as { newTabId?: number } | undefined
  let providerTab = clicked?.newTabId ?? siteTab
  if (providerTab !== siteTab) input.onTab?.(providerTab)
  const filled = new Set<string>()
  const pressed = new Set<string>()
  const askedInfo = new Set<string>()
  let graceInfo = 0

  // 3) 결과를 보면서 공급자 화면의 단계를 넘긴다
  let blankWaits = 0
  /** 공급자 화면을 한 번이라도 봤다 / 그 뒤 사이트 로그인 화면으로 돌아온 횟수 */
  let sawProvider = false
  let backToLogin = 0
  /** 공급자 화면의 로그인된 계정을 사용자가 확인했다 (또는 전에 확인한 계정이다) */
  let accountOk = false
  /** (필수) 동의 칸마다 눌러 본 횟수 */
  const requiredTries = new Map<string, number>()
  for (let i = 0; i < (opts.tries ?? 14); i++) {
    await sleep(wait)
    const site = await snap(siteTab).catch(() => undefined)
    if (site && looksSignedIn(input.card, site, { sawEntry: true })) {
      if (providerTab !== siteTab) await browser.call('close', { tabId: providerTab }).catch(() => undefined)
      return { status: 'ok', tabId: siteTab }
    }
    const p = await snap(providerTab).catch(() => undefined)
    if (!p) {
      // 팝업이 닫혔다: 사이트 탭에서 마저 본다
      if (providerTab !== siteTab) input.onTab?.(siteTab)
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
    if (onProvider) sawProvider = true
    if (!onProvider) {
      // 로그인 뒤 돌아온 콜백 페이지가 아직 빈 화면이면(리디렉션 중) 조금 더 기다렸다 다시 본다 (실측 알라딘)
      // — 바로 '못 했어요'로 끝내면 로그인이 실제로는 되던 걸 놓친다
      if (p.text.replace(/\s/g, '').length < 40 && blankWaits++ < 6) {
        await sleep(Math.max(wait, 1_500))
        continue
      }
      // 공급자 인증은 끝났는데 이 계정과 연결된 사이트 회원이 없다: "이미 회원이신가요? / 회원가입" 화면
      // (실측 교보·예스24). 필수 약관만 있는 간편 가입이면 두리가 가입하고, 본인인증이 필요하면 사람에게 넘긴다
      // 휴면 계정 깨우기: (필수) 동의만이면 고르고 [로그인 완료]를 누른다 (한 화면에 한 번)
      const dormant = dormantScreen(p.text)
      if (dormant?.kind === 'human')
        return {
          status: 'human',
          tabId: providerTab,
          reason: `${input.card.name} 계정이 오래 쓰지 않아 쉬고 있어요. 다시 쓰려면 ${dormant.why}이 필요해요`,
        }
      if (dormant && !pressed.has(`${p.url}|dormant`)) {
        pressed.add(`${p.url}|dormant`)
        step(`오래 쉬던 ${input.card.name} 계정 깨우는 중`)
        for (const ref of dormant.required)
          await browser.call('click', { tabId: providerTab, ref }, 15_000).catch(() => undefined)
        await browser
          .call('click', { tabId: providerTab, ref: dormant.submit }, 30_000)
          .catch(() => undefined)
        continue
      }
      const join = joinScreen(p.text)
      // 가입 버튼을 누른 뒤 본인인증 화면이 나오면 사람 차례 (실측 교보: 회원가입 → 휴대폰 본인인증)
      const joined = [...pressed].some((k) => k.endsWith('|join'))
      const hum = joined && !join && JOIN_HUMAN.exec(p.text)
      if (hum)
        return {
          status: 'human',
          tabId: providerTab,
          reason: `${input.card.name} 가입에 ${hum[0].replace(/\s/g, '')}이 필요해요. 화면에서 인증해 주시면 두리가 이어서 해요`,
        }
      // 이 공급자 계정으로 가입된 회원이 없다는 화면 (가입 버튼이 없어 joinScreen이 못 잡는 것) — 실측 에어비앤비·이스타·캐치테이블·사람인
      if (!join && (NOT_MEMBER.test(said(p.text)) || NOT_MEMBER_URL.test(p.url))) {
        const cert = JOIN_HUMAN.exec(said(p.text))
        return {
          status: 'human',
          tabId: providerTab,
          reason: `${input.card.name}에 이 ${label} 계정과 연결된 회원이 없어요.${cert ? ` 가입에 ${cert[0].replace(/\s/g, '')}이 필요해요.` : ''} 이미 쓰는 계정이 있으면 그 방법으로 연결해 주세요`,
        }
      }
      // 공급자 인증을 거쳤는데 사이트 로그인 화면으로 돌아왔다: 이 계정으로 가입된 회원이 없거나 사이트가 연동을 안 받았다
      // (실측 아시아나·진에어·숲나들e·서울예약·CGV). 두 번 연달아 보이면 그렇게 알린다
      const at = new URL(p.url)
      // 콜백 주소(/login/oauth/callback?code=…)는 지나가는 길이라 세지 않는다. 연달아 두 번일 때만
      const backAtLogin =
        sawProvider &&
        LOGIN_PATH.test(at.pathname) &&
        !/callback|oauth|redirect|result/i.test(at.pathname) &&
        !/[?&](code|state)=/.test(at.search)
      backToLogin = backAtLogin ? backToLogin + 1 : 0
      if (backToLogin >= 2)
        return {
          status: 'human',
          tabId: providerTab,
          reason: `${input.card.name}에 이 ${label} 계정과 연결된 회원이 없는 것 같아요(로그인 화면으로 돌아왔어요). 이미 쓰는 계정이 있으면 그 방법으로 연결해 주세요`,
        }
      if (join?.kind === 'existing')
        return {
          status: 'human',
          tabId: providerTab,
          reason: `${input.card.name}에 이미 계정${join.account ? `(${join.account})` : ''}이 있어요. 그 계정 비밀번호로 한 번 로그인하면 ${label}와 연결돼요`,
        }
      if (join) {
        const key = `${p.url}|join`
        if (join.kind === 'auto' && !input.join)
          return {
            status: 'human',
            tabId: providerTab,
            reason: `${input.card.name}에 이 ${label} 계정과 연결된 회원이 없어요. 이미 쓰는 계정이 있으면 그 방법으로 연결해 주시고, 처음이면 가입할게요`,
          }
        if (join.kind === 'human' || pressed.has(key))
          return {
            status: 'human',
            tabId: providerTab,
            reason:
              join.kind === 'human'
                ? `${input.card.name}에 이 ${label} 계정과 연결된 회원이 없어요. 가입에 ${join.why}이 필요해요`
                : `${input.card.name} 가입을 마치지 못했어요. 화면을 보면서 마저 해 주세요`,
          }
        pressed.add(key)
        step(`${input.card.name}에 ${label} 계정으로 가입하는 중`)
        for (const ref of join.required)
          await browser.call('click', { tabId: providerTab, ref }, 15_000).catch(() => undefined)
        await browser.call('click', { tabId: providerTab, ref: join.submit }, 30_000).catch(() => undefined)
      }
      continue
    }
    // 공급자 앱에서 승인(카카오톡 로그인 확인 등): 카드에 알리고 기다린다.
    // "이 브라우저에서 2단계 인증 사용 안 함"이 있으면 먼저 고른다 (사용자 PC의 평소 브라우저라 다음부터 묻지 않게)
    if (APP_CONFIRM.test(said(p.text))) {
      const remember = ([...parseRefs(p.text)] as RefEntry[]).find(
        ([ref, r]) => r.role === '체크박스' && REMEMBER_BROWSER.test(r.name) && !checkedRefs(p.text).has(ref),
      )
      if (remember)
        await browser.call('click', { tabId: providerTab, ref: remember[0] }, 15_000).catch(() => undefined)
    }
    const confirm = await waitConfirm(p, providerTab, snap, input.step, wait)
    if (confirm === 'moved') continue
    if (confirm === 'timeout')
      return {
        status: 'human',
        tabId: providerTab,
        reason: `${confirmWhere(p.text)}에서 확인을 아직 기다리고 있어요. 확인을 누르시면 두리가 이어서 연결해요`,
      }
    if (STEP2.test(said(p.text)) && !CAPTCHA.test(said(p.text))) {
      step('인증번호를 기다리는 중')
      const a = await answerOnScreen(browser, providerTab, p, input.ask, askedInfo)
      if (a === 'done') {
        graceInfo = 3
        continue
      }
      if (graceInfo-- > 0) continue
    }
    if (CAPTCHA.test(said(p.text)) || p.captcha || STEP2.test(said(p.text)))
      return { status: 'human', tabId: providerTab, reason: humanReason(p.text) }
    // 본인인증 창(토스·PASS·휴대폰 인증: 이름·휴대폰·생년월일을 넣고 앱으로 승인)은 사람이 해야 해요.
    // 무엇을 하면 되는지 또박또박 알려 주고 넘겨요 (실측 SSG 토스 인증)
    const cert = certScreen(p.text)
    if (cert) return { status: 'human', tabId: providerTab, reason: cert }
    const origin = new URL(p.url).origin
    // 공급자 로그인 화면: 금고 값이 있으면 넣고, 없으면 사람 차례
    const two = twoStep(p.text)
    if (hasPassword(p.text) || two) {
      // 금고에 없으면 폰 입력 화면으로 받는다 (한 번 넣으면 금고에 남아 다음부터는 안 묻는다)
      const creds =
        (await input.creds(origin)) ??
        (filled.has(p.url) ? undefined : await input.ask?.credentials?.(origin, `${label} 계정`, providerTab))
      if (!creds || filled.has(p.url))
        return {
          status: 'human',
          tabId: providerTab,
          reason: `${label} 로그인이 필요해요. 한 번 로그인해 두면 다음부터는 두리가 버튼만 눌러요`,
        }
      filled.add(p.url)
      step(`${label} 계정 넣는 중`)
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
      // 사용자의 평소 PC라 '로그인 상태 유지'를 켠다: 끄면 서비스마다 카카오 로그인·카톡 확인을 또 해야 했다 (실측 11번가→올리브영)
      const keep = keepSignedIn(p.text)
      if (keep) await browser.call('click', { tabId: providerTab, ref: keep }, 15_000).catch(() => undefined)
      if (f.submit)
        await browser.call('click', { tabId: providerTab, ref: f.submit[0] }, 30_000).catch(() => undefined)
      else await browser.call('press', { tabId: providerTab, key: 'Enter' }).catch(() => undefined)
      continue
    }
    if (WRONG.test(said(p.text)))
      return {
        status: 'wrong',
        tabId: providerTab,
        message: `${label} 아이디나 비밀번호가 맞지 않는 것 같아요. 화면을 보고 확인해 주세요.`,
      }
    // 계정 고르기(구글): 이메일이 적힌 줄을 누른다. 여럿이면 전에 고른 것, 없으면 사람에게 한 번 묻고 기억한다
    // (실측 알라딘: 구글 계정이 둘이라 첫째를 누르면 엉뚱한 계정으로 가입될 수 있다)
    const refs = [...parseRefs(p.text)] as RefEntry[]
    // 계정 고르기 화면에서만 이메일 줄을 계정으로 본다. 고른 뒤의 확인 화면에도 "○○@gmail.com 항목이 선택되었습니다. 계정 전환"
    // 줄이 있는데, 이걸 눌러 고르기 화면으로 되돌아가 멈췄다 (실측 부킹닷컴·G마켓·에어비앤비·오아시스·이스타)
    const choosing = /accountchooser|gsi\/select|계정을?\s?선택|choose an account/i.test(`${p.url} ${p.text}`)
    const accounts = choosing
      ? refs.filter(
          ([, r]) =>
            (r.role === '링크' || r.role === '버튼') &&
            /@/.test(r.name) &&
            !/계정\s?전환|switch account|선택되었습니다/i.test(r.name),
        )
      : []
    let account = accounts.length === 1 ? accounts[0] : undefined
    if (accounts.length > 1) {
      const names = accounts.map(([, r]) => r.name.trim())
      const remembered = input.ask?.account?.get(input.provider)
      // 기억한 것은 화면 글 그대로이거나 이메일 주소(mdjoo…@gmail.com): 가린 이메일(m***@gmail.com)과 맞춰 본다
      const sameMail = (n: string, mail: string) => {
        const shown = /([^\s@,]+)@([^\s@,]+)/.exec(n)
        const [user = '', domain = ''] = mail.toLowerCase().split('@')
        if (!shown || !domain) return false
        const head = (shown[1] ?? '').toLowerCase().replace(/\*+.*$/, '')
        return (shown[2] ?? '').toLowerCase() === domain && head.length > 0 && user.startsWith(head)
      }
      const byMail =
        remembered?.includes('@') && !remembered.includes(' ')
          ? names.filter((n) => sameMail(n, remembered))
          : []
      let pick =
        (remembered && names.find((n) => n === remembered)) || (byMail.length === 1 ? byMail[0] : undefined)
      if (!pick && input.ask?.info) {
        step(`${label} 계정 고르기를 기다리는 중`)
        const a = await input.ask.info({
          field: 'choice',
          label: `어느 ${label} 계정으로 할까요?`,
          hint: `${input.card.name}에 이 계정으로 로그인해요. 고른 계정은 기억해 두고 다음부터 묻지 않아요.`,
          host,
          options: names,
        })
        pick = a && names.find((n) => n === a.trim())
        if (pick) input.ask.account?.set(input.provider, pick)
      }
      if (!pick)
        return {
          status: 'human',
          tabId: providerTab,
          reason: `${label} 계정이 여러 개라 어느 것으로 할지 골라 주셔야 해요`,
        }
      account = accounts.find(([, r]) => r.name.trim() === pick)
    }
    // 동의를 누르기 전에: 공급자에 지금 로그인된 계정이 사용자가 확인해 준 계정인지 본다.
    // (실측 알라딘 2026-11-18: 이 PC Chrome의 카카오는 평소 계정이 아닌 f***@gmail.com이었는데 그대로 동의를 눌렀다)
    // 처음 보는 계정이면 한 번 묻고, 아니라고 하면 '계정 변경'을 열어 사용자에게 넘긴다
    const who = account ? undefined : providerAccountOn(p.text)
    if (who && !accountOk) {
      if (input.ask?.known?.has(input.provider, who)) accountOk = true
      else {
        step(`${label} 계정 확인을 기다리는 중`)
        const yes = `${who}(으)로 할게요`
        const a = input.ask?.info
          ? await input.ask.info({
              field: 'choice',
              label: `${label} 계정 ${who}(으)로 ${input.card.name}에 로그인할까요?`,
              hint: `이 PC에 로그인된 ${label} 계정이에요. 처음 보는 계정이라 여쭤봐요. 맞으면 기억해 두고 다음부터 묻지 않아요.`,
              host,
              options: [yes, '다른 계정이에요'],
            })
          : undefined
        if (a?.trim() === yes) {
          input.ask?.known?.add(input.provider, who)
          accountOk = true
        } else {
          const change = refs.find(
            ([, r]) => (r.role === '링크' || r.role === '버튼') && /계정\s?변경|다른\s?계정/.test(r.name),
          )
          if (a && change)
            await browser.call('click', { tabId: providerTab, ref: change[0] }, 30_000).catch(() => undefined)
          return {
            status: 'human',
            tabId: providerTab,
            reason: a
              ? `${label} 계정을 바꾸는 화면이에요. 쓰시는 ${label} 계정으로 로그인해 주시면 두리가 이어서 해요`
              : `${label}에 로그인된 계정(${who})이 맞는지 확인이 필요해요`,
          }
        }
      }
    }
    // 정보 제공 동의에 (필수) 칸이 있으면 그것만 고른다 (선택 항목은 건드리지 않는다). 실측 알라딘 카카오
    const required = refs.filter(
      ([, r]) => r.role === '체크박스' && /\(필수\)|\[필수\]|필수\s/.test(r.name) && !/선택됨/.test(r.name),
    )
    if (required.length && !account) {
      const checked = checkedRefs(p.text)
      // 칸을 눌러도 체크되지 않는 화면이 있다 (실측 올리브영 카카오 동의: 칸 옆 같은 이름의 글자 줄을 눌러야 한다).
      // 처음엔 칸, 다음엔 같은 이름의 버튼, 그래도 안 되면 사람 차례 (같은 칸만 계속 누르며 시간을 쓰지 않게)
      const open = required.filter(([ref]) => !checked.has(ref))
      for (const [ref, r] of open) {
        const n = (requiredTries.get(r.name) ?? 0) + 1
        requiredTries.set(r.name, n)
        const twin = refs.find(([, x]) => x.role === '버튼' && x.name.trim() === r.name.trim())
        const target = n === 1 || !twin ? ref : twin[0]
        if (n <= 2)
          await browser.call('click', { tabId: providerTab, ref: target }, 15_000).catch(() => undefined)
      }
      if (open.some(([, r]) => (requiredTries.get(r.name) ?? 0) > 2))
        return {
          status: 'human',
          tabId: providerTab,
          reason: `${label} 동의 화면의 (필수) 칸이 눌러지지 않아요. 화면에서 (필수) 칸을 고르고 [동의하고 계속하기]를 눌러 주세요`,
        }
      if (open.length) {
        step('필수 정보 제공 동의 고르는 중')
        continue
      }
    }
    // 정보 제공 동의: "동의하고 계속하기"
    const consent = refs.find(([, r]) => r.role === '버튼' && CONSENT.test(r.name.trim()))
    const next = account ?? consent
    if (next && !pressed.has(`${p.url}|${next[1].name}`)) {
      pressed.add(`${p.url}|${next[1].name}`)
      step(account ? '계정 고르는 중' : '정보 제공 동의 넘기는 중')
      await browser.call('click', { tabId: providerTab, ref: next[0] }, 30_000).catch(() => undefined)
    }
  }
  // 끝난 화면이 중간 페이지(콜백·안내)라 모르겠으면, 사이트 첫 화면을 새로 열어 한 번 더 본다
  // (로그인은 쿠키로 남아 있다: 그 화면에 로그인 입구가 없으면 로그인된 것)
  if (input.card.site) {
    const home = (await browser
      .call('open', { url: `https://${input.card.site}/` }, 40_000)
      .catch(() => undefined)) as { tabId: number } | undefined
    if (home?.tabId !== undefined) {
      const h = await settled(() => snap(home.tabId), wait).catch(() => undefined)
      if (h && looksSignedIn(input.card, h, { sawEntry: true })) {
        for (const t of new Set([providerTab, siteTab]))
          await browser.call('close', { tabId: t }).catch(() => undefined)
        return { status: 'ok', tabId: home.tabId }
      }
      await browser.call('close', { tabId: home.tabId }).catch(() => undefined)
    }
  }
  return {
    status: 'unknown',
    tabId: providerTab,
    message: `${label} 로그인을 마쳤는지 확인하지 못했어요. 화면을 보고 확인해 주세요.`,
  }
}

/** 이 공급자 계정으로 가입된 회원이 없다는 말 */
const NOT_MEMBER =
  /계정을\s?만드세요|연동된\s?회원\s?정보를\s?찾을\s?수\s?없|SNS\s?계정\s?미연동|가입된\s?(회원|정보|계정)이?\s?없|등록된\s?회원이\s?없|연결된\s?(회원|계정)이\s?없|회원\s?정보가\s?없|create (an|your) account/i
/** 간편 가입으로 넘어간 주소 */
const NOT_MEMBER_URL = /\/(join|signup|sign-up|register|registration)(\b|[/?#])|social-terms/i
/** 로그인 화면 주소 */
const LOGIN_PATH = /\/(login|signin|sign-in|sign_in)(\b|[/?#._])|viewLogin|login\.(do|aspx|jsp)/i
const JOIN_PAGE =
  /(이미|기존)\s?.{0,12}회원이신가요|아직\s?.{0,12}회원이\s?아니|회원가입을\s?하시겠|SNS\s?(로그인\s?)?연동|계정\s?연동|간편\s?회원\s?가입/
const JOIN_HUMAN = /본인\s?인증|휴대폰\s?인증|휴대전화\s?인증|아이핀|i-?PIN|인증번호/

/**
 * 간편 로그인 뒤 "이 계정과 연결된 회원이 없어요" 화면. 가입 버튼과 아직 고르지 않은 (필수) 약관 칸.
 * 같은 화면에 본인인증이 있으면 사람 차례(why). 아니면 undefined
 */
export function joinScreen(
  text: string,
):
  | { kind: 'auto'; submit: string; required: string[] }
  | { kind: 'human'; why: string }
  | { kind: 'existing'; account?: string }
  | undefined {
  // 가입하려 했더니 "이미 가입된 정보가 있어요(아이디 coffeeplan)": 그 계정으로 로그인하면 연동된다 (실측 교보)
  // "신세계포인트 통합회원으로 가입한 아이디는 mdj****10입니다" (실측 신세계면세점)
  if (/이미\s?가입된\s?(정보|계정|회원)|기존\s?계정\s?안내|이미\s?가입하신|가입한\s?아이디는/.test(text)) {
    const id =
      /\[e\d+ 라디오 "([^"]{2,40})"/.exec(text)?.[1] ??
      /아이디(?:는|[:\s])\s*([A-Za-z0-9_.@*-]{3,40}?)(?:입니다|\s|$)/.exec(text)?.[1]
    return { kind: 'existing', ...(id ? { account: id } : {}) }
  }
  if (!JOIN_PAGE.test(text)) return undefined
  const refs = [...parseRefs(text)] as RefEntry[]
  const submit = refs.find(
    ([, r]) =>
      (r.role === '버튼' || r.role === '링크') &&
      /^(간편\s?)?(회원\s?가입|가입하기|가입\s?완료|동의하고\s?가입(하기)?)$/.test(r.name.trim()),
  )
  if (!submit) return undefined
  // 가입 버튼을 누르기 전 화면에 본인인증 칸이 보이면 사람 차례 (가입 버튼 뒤에 나오는 건 다음 화면에서 본다)
  const human = JOIN_HUMAN.exec(
    text
      .split('\n')
      .filter((l) => !/본인인증이 필요한 서비스|본인인증 이후 이용/.test(l))
      .join('\n'),
  )
  if (human) return { kind: 'human', why: human[0].replace(/\s/g, '') }
  const checked = checkedRefs(text)
  const required = refs
    .filter(([ref, r]) => r.role === '체크박스' && /필수/.test(r.name) && !checked.has(ref))
    .map(([ref]) => ref)
  return { kind: 'auto', submit: submit[0], required }
}

/**
 * 휴면(장기 미사용) 계정 깨우기 화면: 로그인 뒤 "장기 미사용 계정으로 약관 동의가 필요합니다" (실측 11번가 2026-11-19).
 * (필수) 동의 칸과 [로그인 완료]·[휴면 해제]만 있으면 두리가 고르고 누른다. 휴대폰 본인인증 칸이 있으면 사람 차례(why)
 */
export function dormantScreen(
  text: string,
): { kind: 'auto'; submit: string; required: string[] } | { kind: 'human'; why: string } | undefined {
  if (!/휴면|장기\s?미사용/.test(said(text))) return undefined
  const refs = [...parseRefs(text)] as RefEntry[]
  const human = JOIN_HUMAN.exec(said(text))
  if (human || refs.some(([, r]) => r.role === '입력칸' && /휴대폰|전화|이름|생년월일|인증/.test(r.name)))
    return { kind: 'human', why: (human?.[0] ?? '본인인증').replace(/\s/g, '') }
  const submit = refs.find(
    ([, r]) =>
      (r.role === '버튼' || r.role === '링크') &&
      /^(로그인\s?완료|휴면\s?(계정\s?)?해제(하기)?|해제하기|동의하고\s?(로그인|계속|해제)(하기)?|확인|다음|완료)$/.test(
        r.name.trim(),
      ),
  )
  if (!submit) return undefined
  const checked = checkedRefs(text)
  const required = refs
    .filter(([ref, r]) => r.role === '체크박스' && /필수|전체\s?동의/.test(r.name) && !checked.has(ref))
    .map(([ref]) => ref)
  return { kind: 'auto', submit: submit[0], required }
}

/** 점검용: 로그인 화면에 있는 간편 로그인 공급자 */
export function socialProvidersIn(text: string): SocialProvider[] {
  return (Object.keys(SOCIAL_PROVIDERS) as SocialProvider[]).filter((p) => findProviderButton(text, p))
}
