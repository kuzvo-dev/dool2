// Korean text aimed at an AI in pages, mail and files (injection-note.ts, ADR 0029: Korean data lives here).
// Each pattern needs words that address an AI or override earlier instructions, together with an order.

const AI = '(?:AI|에이아이|인공지능|챗봇|비서|어시스턴트|에이전트|언어 ?모델)'
/**
 * An action word followed by an imperative or "must" ending. Not "줘" or "주세요": product pages quote what
 * people say to their AI speaker ("비서에게 '메일 보내줘'라고 말해 보세요")
 */
const ORDER =
  '(?:보내|전달|전송|발송|삭제|지워|지우|클릭|눌러|누르|송금|이체|결제|구매|공유|열어|접속|방문|알려|입력|가입|다운로드|실행)' +
  '(?:라|해라|하라|세요|하세요|십시오|하십시오|할 ?것|해야 ?(?:한다|합니다))'

export const INJECTION_KO: [string, RegExp][] = [
  // 이전 지시를 무시하고 / 앞의 명령은 잊어라
  [
    'override',
    /(?:이전|앞|위|기존|지금까지|원래)[의에서 ]*\s*(?:모든\s*)?(?:지시|명령|지침|규칙|프롬프트)(?:사항)?[을를은는과와도]?\s*(?:모두\s*|전부\s*)?(?:무시|잊|따르지)/,
  ],
  // AI 비서는 … 보내라 / 이 글을 읽는 AI는 … 전달하세요
  [
    'address',
    new RegExp(`${AI}\\s*(?:는|은|에게|한테|님|들은|라면|이라면)(?:[^.\\n]|\\.(?=\\S)){0,60}?${ORDER}`),
  ],
  // 사용자에게 알리지 말고
  [
    'secret',
    /(?:사용자|주인|이용자|고객)(?:에게|한테|께)?\s*(?:알리지|말하지|보여 ?주지)\s*(?:말고|마라|마세요|말 것)/,
  ],
]
