// 브라우저 도구. AI가 사용자 Chrome의 "두리" 탭에서 웹 일을 한다.
// 이 서버는 판단하지 않는다: 두리 본체(/api/tools/browser)에 넘기고, 위험한 동작은 본체가 막는다.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
}

/** 본체에 도구 실행을 부탁한다 */
export type BrowserClient = (tool: string, args: Record<string, unknown>) => Promise<ToolResult>

/** 본체 주소·토큰은 본체가 이 서버를 띄울 때 환경 변수로 넣어 준다 */
export function daemonClient(env: NodeJS.ProcessEnv = process.env, kind = 'browser'): BrowserClient {
  return async (tool, args) => {
    const api = env.DOOL2_API
    const token = env.DOOL2_TOOL_TOKEN
    if (!api || !token) return fail('두리 본체와 연결돼 있지 않아요')
    try {
      const res = await fetch(`${api}/api/tools/${kind}/${encodeURIComponent(tool)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(90_000),
      })
      if (!res.ok) return fail(`두리 본체가 거절했어요 (${res.status})`)
      return (await res.json()) as ToolResult
    } catch (e) {
      return fail(`두리 본체에 닿지 못했어요: ${(e as Error).message}`)
    }
  }
}

const fail = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] })

const tabId = z.number().int().describe('탭 번호 (browser_open이 알려 준 [탭 N])')
const ref = z
  .string()
  .regex(/^e\d+$/)
  .describe('페이지를 읽었을 때 나온 표시 (예: e12)')

export function registerBrowserTools(server: McpServer, client: BrowserClient) {
  const tool = (
    name: string,
    title: string,
    description: string,
    // biome-ignore lint/suspicious/noExplicitAny: MCP SDK의 zod 입력 형식
    inputSchema: Record<string, any>,
    readOnly: boolean,
  ) =>
    server.registerTool(
      `browser_${name}`,
      { title, description, inputSchema, annotations: { readOnlyHint: readOnly, openWorldHint: true } },
      async (args: Record<string, unknown>) => {
        const r = await client(name, args)
        return { content: r.content, ...(r.isError ? { isError: true } : {}) }
      },
    )

  tool(
    'open',
    '새 탭 열기',
    '사용자 Chrome의 "두리" 창에 새 탭을 열고 페이지를 글로 읽어 돌려준다. 평소 로그인이 그대로 쓰인다. 웹에서 무언가 찾거나 할 때 가장 먼저 쓴다.',
    { url: z.string().describe('열 주소 (예: https://www.naver.com)') },
    true,
  )
  tool(
    'navigate',
    '주소 이동',
    '이미 연 두리 탭에서 다른 주소로 이동하고 페이지를 읽어 돌려준다.',
    { tabId, url: z.string() },
    true,
  )
  tool(
    'read',
    '페이지 읽기',
    '탭의 지금 페이지를 글로 읽는다. 누를 수 있는 것은 [e12 버튼 "검색"]처럼 표시된다. 글이 잘렸으면 maxChars를 늘린다.',
    { tabId, maxChars: z.number().int().min(1000).max(40000).optional() },
    true,
  )
  tool(
    'click',
    '누르기',
    '표시(ref)한 버튼·링크를 실제 마우스로 누르고 바뀐 페이지를 읽어 돌려준다. 표시가 없는 상자(검색 결과의 가게·상품 카드 등)는 ref 대신 text에 화면에 보이는 글자(가게 이름 등)를 그대로 넣으면 그 글자를 누른다. 결제·주문·보내기·삭제 같은 버튼은 두리가 막고 사용자에게 넘긴다.',
    {
      tabId,
      ref: ref.optional(),
      text: z
        .string()
        .max(80)
        .optional()
        .describe('ref가 없을 때: 누를 곳의 화면 글자 그대로 (예: 가게 이름 "ACENO 아세누")'),
    },
    false,
  )
  tool(
    'type',
    '입력하기',
    '표시(ref)한 입력칸에 글자를 넣는다(원래 글자는 바뀐다). submit이 true면 Enter도 누른다. 비밀번호 칸에는 넣을 수 없다.',
    { tabId, ref, text: z.string().max(2000), submit: z.boolean().optional() },
    false,
  )
  tool(
    'press',
    '키 누르기',
    'Enter, Tab, Escape, ArrowDown, PageDown 같은 키를 누른다.',
    { tabId, key: z.string().max(20) },
    false,
  )
  tool(
    'steps',
    '여러 동작 한 번에',
    '읽은 화면에서 이어지는 동작(칸 여러 개 채우기, 고르고 누르기 등)을 한 번에 차례로 하고, 끝난 뒤 페이지를 한 번만 읽어 돌려준다. 동작은 click(ref 또는 text)·type(ref, text, submit)·press(key)·scroll(direction)·wait(ms)만. 다른 화면으로 넘어가거나 새 탭·확인 창이 뜨거나 막히면 거기서 멈추고 남은 동작은 하지 않는다. 결제·주문·보내기·삭제 같은 버튼은 browser_click과 똑같이 막힌다.',
    {
      tabId,
      steps: z
        .array(
          z.object({
            do: z.enum(['click', 'type', 'press', 'scroll', 'wait']).describe('할 동작'),
            ref: ref.optional().describe('click·type: 표시'),
            text: z
              .string()
              .max(2000)
              .optional()
              .describe('type: 넣을 글 / click: ref가 없을 때 누를 화면 글자'),
            submit: z.boolean().optional().describe('type: 넣고 Enter'),
            key: z.string().max(20).optional().describe('press: 키 이름 (Enter, Tab, Escape …)'),
            direction: z.enum(['up', 'down']).optional().describe('scroll: 방향'),
            ms: z.number().int().min(100).max(5000).optional().describe('wait: 기다릴 시간(ms)'),
          }),
        )
        .min(1)
        .max(12)
        .describe('차례로 할 동작 (최대 12개)'),
      maxChars: z.number().int().min(1000).max(40000).optional(),
    },
    false,
  )
  tool(
    'scroll',
    '스크롤',
    '화면을 한 화면 위나 아래로 움직인다. 화면 캡처 전에 쓴다(페이지 읽기는 스크롤 없이 전체를 읽는다).',
    { tabId, direction: z.enum(['up', 'down']) },
    true,
  )
  tool(
    'screenshot',
    '화면 보기',
    '탭의 보이는 화면을 그림으로 본다. 글로 읽어서 알 수 없을 때(그림·지도·표 모양)만 쓴다.',
    { tabId },
    true,
  )
  tool('back', '뒤로', '탭에서 뒤로 가기를 누르고 페이지를 읽어 돌려준다.', { tabId }, true)
  tool(
    'login',
    '두리 금고로 로그인 칸 채우기',
    '사용자가 두리 금고에 저장해 둔 사이트면, 아이디·비밀번호 칸을 두리가 직접 채운다. 값은 보이지 않는다. 채운 뒤 로그인 버튼은 browser_click으로 누른다. 금고에 없으면 browser_request_login으로 로그인 카드를 띄운다.',
    {
      tabId,
      passwordRef: ref.describe('비밀번호칸 표시 (예: e7)'),
      usernameRef: ref.optional().describe('아이디 입력칸 표시. 아이디가 이미 채워져 있으면 생략'),
    },
    false,
  )
  tool(
    'request_login',
    '로그인 카드 띄우기',
    '로그인 페이지인데 두리 금고에 그 사이트가 없을 때 쓴다(browser_login이 "금고에 없어요"라고 할 때). 사용자에게 PC·폰 대화 안 로그인 카드를 띄운다. 사용자가 넣은 아이디·비밀번호는 금고에만 저장되고 너에게는 오지 않는다. 쓴 뒤에는 이번 답을 끝낸다. 로봇 확인·본인인증·문자 인증은 browser_handoff로.',
    {
      tabId,
      site: z.string().max(60).describe('사용자에게 보일 사이트 이름 (예: "코스트코")'),
    },
    false,
  )
  tool(
    'request_approval',
    '승인 요청',
    '결제·주문·예약 확정·보내기·삭제처럼 승인이 필요한 버튼이면 쓴다(browser_click이나 browser_dialog가 "승인 없이는 하지 않아요"라고 할 때). 사용자가 PC나 폰에서 화면 캡처와 내용을 보고 승인하면 두리가 그 버튼만 직접 누른다. 사이트 확인 창의 [확인]이면 ref 대신 dialog: true. 쓴 뒤에는 이번 답을 끝낸다.',
    {
      tabId,
      ref: ref.optional().describe('누를 버튼 표시 (확인 창이면 생략)'),
      dialog: z.boolean().optional().describe('떠 있는 사이트 확인 창의 [확인]을 승인받을 때 true'),
      what: z.string().max(200).describe('무엇을 (예: "사과 1kg 바로 구매")'),
      where: z.string().max(100).describe('어디서 (예: "두리 시험 가게")'),
      amount: z.string().max(60).optional().describe('얼마 (페이지에 적힌 그대로, 예: "9,900원")'),
      cancel: z.string().max(200).optional().describe('취소·환불 조건 (모르면 "안내 없음")'),
    },
    false,
  )
  tool(
    'dialog',
    '사이트 확인 창 고르기',
    '페이지를 읽었을 때 "사이트 확인 창이 떠 있어요"라고 나오면 쓴다. 사이트가 띄운 확인 창(예: "장바구니로 이동할까요?")에서 [확인](accept: true)이나 [취소](accept: false)를 누르고 바뀐 페이지를 읽어 돌려준다. 글을 넣는 창이면 text에 넣을 글. 결제·주문·보내기·삭제가 되는 [확인]은 두리가 막고 승인을 받게 한다.',
    {
      tabId,
      accept: z.boolean().describe('[확인]이면 true, [취소]면 false'),
      text: z.string().max(500).optional().describe('글을 넣는 창일 때 넣을 글'),
    },
    false,
  )
  tool(
    'handoff',
    '사람에게 넘기기',
    '로봇 확인(캡차), 본인인증·문자 인증, 결제·주문·보내기 같은 마지막 버튼처럼 사람이 직접 해야 할 때 쓴다(아이디·비밀번호 로그인은 browser_request_login). 두리 탭을 사용자 앞에 띄우고 무엇을 해 달라는지 알린다. 쓴 뒤에는 이번 답을 끝낸다.',
    {
      tabId,
      reason: z
        .string()
        .max(200)
        .describe('사용자에게 보일 부탁 (예: "네이버 로그인이 풀려 있어요. 로그인해 주세요")'),
    },
    false,
  )
  tool('close', '탭 닫기', '다 쓴 두리 탭을 닫는다. 일이 끝나면 연 탭을 닫는다.', { tabId }, false)
}
