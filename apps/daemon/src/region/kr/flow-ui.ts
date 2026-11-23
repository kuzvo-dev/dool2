// Korean Google Flow screen text the video clip maker matches in snapshots (the browser runs in Korean)
export const btn = (label: string) => new RegExp(`\\[(e\\d+) 버튼 "${label}"\\]`)
export const radio = (label: string) => new RegExp(`\\[(e\\d+) 라디오 "${label}"( 선택됨)?\\]`)
export const NEW_PROJECT = btn('(?:add )?새 프로젝트')
export const INPUT = /\[(e\d+) 입력칸 "무엇을 만들고 싶으신가요\?"\]/
export const AGENT_ON = /\[(e\d+) 버튼 "Flow 에이전트" 선택됨\]/
export const SETTINGS = btn('설정 트리거')
export const GO = /\[(e\d+) 버튼 "생성 시작"\]/
export const CREDITS = /생성 시 \[e\d+ 링크 "(\d+) 크레딧"\]/
export const THUMB = /\[그림 "생성된 동영상 썸네일"\]/g
export const DOWNLOAD = btn('미디어 다운로드')
export const ORIGINAL = /\[(e\d+) 메뉴 "(?:720p|1080p)? ?원본 크기"\]/
/** First use: research participation and privacy notice consent */
export const CONSENT = /개인정보처리방침을 검토하세요|마케팅 이메일 수신 동의/
export const NEXT = btn('다음')
export const CONTINUE = btn('계속')
export const COOKIE_LATER = btn('나중에')
/** "What changed" dialog */
export const START = btn('시작하기')
export const CHANGELOG_NEXT = btn('Next')
export const SIGNED_OUT = /\[(e\d+) (?:링크|버튼) "(?:로그인|Sign in)"\]/
/** In-progress marker (measured: [e40 버튼 "play_circle 30%"]) */
export const PROGRESS = /\[e\d+ 버튼 "[a-z_]* ?\d{1,3}%"\]/
/** Warning that credits are short for the NEXT generation. It says nothing about the current one (11-23: reading it as the limit made us quit after 23s) */
export const NEXT_SHORT = /\[e\d+ 버튼 "크레딧 부족 경고"\]/g
export const OPEN_PROJECT = /\[(e\d+) 링크 "프로젝트 열기"\]/
export const LIMIT =
  /크레딧이 부족|크레딧을 모두|크레딧이 없|사용량 한도|한도에 도달|나중에 다시 시도|not enough credits|out of credits|quota/i
export const REFUSED = /정책|가이드라인|생성할 수 없|생성하지 못|실패했|policy|couldn.t generate|failed/i

export const ANY_LINK = /\[(e\d+) 링크 "[^"]*"\]/g
export const START_ENABLED = /\[(e\d+) 버튼 "시작하기"( 비활성)?\]/
export const RADIO_VIDEO = 'videocam 동영상'
export const THUMB_ALT_SELECTOR = 'img[alt="생성된 동영상 썸네일"]'
