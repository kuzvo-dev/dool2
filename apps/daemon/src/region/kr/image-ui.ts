// Korean Gemini / ChatGPT screen text the image maker matches in snapshots (the browser runs in Korean)
export const GEMINI_NAME = '제미나이'
export const GEMINI_DOWNLOAD = /\[(e\d+) 버튼 "원본 크기 이미지 다운로드"\]/g
export const GEMINI_INPUT = /\[(e\d+) 입력칸 "[^"]*(?:프롬프트|prompt|Gemini에게)[^"]*"\]/i
/** First-run dialog: skip, close, start */
export const ONBOARD = /\[(e\d+) 버튼 "(?:건너뛰기|나중에|닫기|시작하기|확인|Skip|Not now|Got it)"\]/
export const SIGNED_OUT = /\[(e\d+) (?:링크|버튼) "(?:로그인|Sign in)"\]/
export const LIMIT = /한도에 도달|한도를 초과|사용량 한도|내일 다시|다시 시도할 수 있|limit reached|quota/i
export const DRAWING = /만들고 있습니다|생성하고 있|생성 중|그리는 중|Creating|Generating/i
export const GEMINI_ANSWERED = /\[(e\d+) 버튼 "대답이 마음에 들어요"\]/g
export const GEMINI_SPLIT = 'Gemini의 응답'
// Not measured yet (the test PC has no ChatGPT login): display names for both Korean and English screens
export const CHATGPT_INPUT = /\[(e\d+) 입력칸 "[^"]*(?:ChatGPT|무엇이든|메시지|Message|Ask)[^"]*"\]/i
export const CHATGPT_DOWNLOAD = /\[(e\d+) 버튼 "[^"]*(?:이미지 다운로드|다운로드|Download)[^"]*"\]/gi
export const CHATGPT_SIGNED_OUT = /\[(e\d+) 버튼 "(?:무료로 회원가입|회원가입|Sign up for free|Sign up)"\]/i
export const CHATGPT_ANSWERED = /\[(e\d+) 버튼 "(?:좋은 응답|Good response)"\]/gi
export const CHATGPT_SPLIT = 'ChatGPT의 말'
/** Default file name stem (the files people see in their Documents folder) */
export const DEFAULT_IMAGE_NAME = '두리 그림'
export const DEFAULT_CLIP_NAME = 'AI 영상 클립'
export const DEFAULT_VIDEO_NAME = '두리 영상'
