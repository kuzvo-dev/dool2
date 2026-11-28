/**
 * Korean copy templates for the drafted SKILL.md body.
 *
 * A drafted skill's body is Korean site-hint DATA (like the hand-written
 * `packages/skills/skills/<id>/SKILL.md` files), not program logic, so the
 * Korean lives here under `locales/` — allowed by the ADR 0029 Hangul check —
 * while the drafting code in `../draft.ts` stays English. The functions below
 * take the recording's data (endpoint lines, UI steps, host) and splice it into
 * these templates; the Korean strings themselves carry no secrets.
 */

/** One-line `description` frontmatter, e.g. `쿠팡 (coupang.com) — ...`. */
export function descriptionLine(name: string, host: string): string {
  return `${name} (${host}) — 사용자 세션으로 돕는 사이트 스킬. 데이터 경로를 먼저 쓰고, 막히면 화면을 조작한다.`
}

/** Title + intro at the top of the body. */
export function bodyIntro(name: string, host: string): string {
  return `# ${name} (${host})\n\n${host}에서 작업할 때 쓰는 요령. 두리가 실제로 먹힌 경로를 기록해 만든 초안이다.`
}

/** Heading for the data-path (internal API) section. */
export const DATA_PATH_HEADING = '## 데이터 경로 (먼저 시도)'

/** Lead-in line before the endpoint list. */
export const DATA_PATH_LEAD = '먼저 이 API를 사용자 세션으로 불러 보세요(로그인 상태면 클릭 없이 바로):'

/** Note when the recording found custom request headers worth resending. */
export function headersNote(names: string[]): string {
  return `- 이 요청들이 보내던 추가 헤더: ${names.join(', ')} (쿠키·세션은 브라우저가 자동으로 붙인다)`
}

/** Shown in the data-path section when no API endpoint was captured yet. */
export const DATA_PATH_EMPTY =
  '아직 잡힌 내부 API가 없다. 작업하면서 네트워크 요청을 지켜보고, 먹히는 조회 API를 찾으면 여기에 추가한다.'

/** Heading for the UI-fallback section. */
export const UI_FALLBACK_HEADING = '## UI 폴백'

/** Lead-in line before the UI step list. */
export const UI_FALLBACK_LEAD = '데이터 경로가 막히면 화면을 직접 조작한다:'

/** Shown in the UI section when no steps were recorded. */
export const UI_FALLBACK_EMPTY = '기록된 화면 단계가 없다. 스냅샷을 보고 필요한 버튼·입력을 직접 찾는다.'

/** Human label for each recorded UI action. */
export function uiActionLabel(action: string): string {
  switch (action) {
    case 'goto':
      return '이동'
    case 'click':
      return '클릭'
    case 'type':
      return '입력'
    case 'fill':
      return '채우기'
    default:
      return action
  }
}

/** Heading for the login section. */
export const LOGIN_HEADING = '## 로그인'

/** Body of the login section (field hints live in frontmatter). */
export const LOGIN_NOTE =
  '이미 로그인돼 있으면 다시 로그인하지 않는다. 로그인이 필요하면 위 프런트매터의 login 힌트가 아이디·비밀번호·로그인 버튼 필드를 짚어 주고, 금고가 그 필드에 비밀을 직접 채운다(AI는 비밀을 보지 않는다).'

/** Heading for the safety section. */
export const SAFETY_HEADING = '## 안전'

/** Standing safety lines every drafted skill carries. */
export const SAFETY_LINES = [
  '- 캡차·본인인증처럼 사람이 해야 하는 단계는 우회하지 말고 사용자에게 넘긴다(hand-off).',
  '- 비밀(비밀번호·카드번호·일회용 번호)은 금고가 처리하고 AI에게 넘기지 않는다. 결제·연락·삭제 같은 되돌리기 어려운 행동은 승인을 거친다.',
]
