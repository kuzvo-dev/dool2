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
        // 인증 앱 승인 기다리기는 3분까지 기다린다 (90초에 끊겨 사용자가 승인 중인데 시간 초과로 봤다)
        signal: AbortSignal.timeout(tool === 'wait_auth' ? 200_000 : 90_000),
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
    '사용자 Chrome의 "두리" 창에 새 탭을 열고 페이지를 글로 읽어 돌려준다. 평소 로그인이 그대로 쓰인다. 웹에서 무언가 찾거나 할 때 가장 먼저 쓴다. 페이지에서 읽은 내용으로 답할 때는 그 줄이나 답 끝에 출처를 ([사이트·화면 이름](그 페이지 주소)) 링크로 붙인다.',
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
    '탭의 지금 페이지를 글로 읽는다(답에 쓰면 출처로 ([화면 이름](페이지 주소)) 링크를 붙인다). 누를 수 있는 것은 [e12 버튼 "검색"]처럼 표시된다. 긴 페이지는 필요한 부분만: from에 찾는 글자(예: "검색 결과")를 넣으면 그 줄부터, view: true면 지금 화면에 보이는 부분만, 잘렸으면 안내된 skip으로 이어서 읽는다.',
    {
      tabId,
      maxChars: z.number().int().min(1000).max(40000).optional(),
      view: z.boolean().optional().describe('true면 지금 화면에 보이는 부분만 (스크롤한 뒤 쓴다)'),
      from: z.string().max(100).optional().describe('이 글자가 나오는 줄부터 읽는다 (위쪽 메뉴 건너뛰기)'),
      skip: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('앞에서 이만큼(글자) 건너뛰고 읽는다 (잘린 뒤를 이어 읽을 때)'),
    },
    true,
  )
  tool(
    'click',
    '누르기',
    '표시(ref)한 버튼·링크를 실제 마우스로 누르고 바뀐 페이지를 읽어 돌려준다. 표시가 없는 상자(검색 결과의 가게·상품 카드 등)는 ref 대신 text에 화면에 보이는 글자(가게 이름 등)를 그대로 넣으면 그 글자를 누른다. 결제·주문·보내기·삭제 말이 있는 버튼은 두리가 막고 승인 카드(결제면 browser_checkout, 보내기·삭제면 browser_request_approval)로 돌린다. 결제를 승인받은 뒤 결제 회사 창 안의 버튼은 다시 막지 않는다.',
    {
      tabId,
      ref: ref.optional(),
      text: z
        .string()
        .max(80)
        .optional()
        .describe('ref가 없을 때: 누를 곳의 화면 글자 그대로 (예: 가게 이름 "ACENO 아세누")'),
      opens_checkout: z
        .boolean()
        .optional()
        .describe(
          '장바구니·주문표의 [주문하기]처럼 결제 화면(결제 수단·최종 금액을 고르는 화면)으로 넘어가기만 하는 버튼이라고 화면을 보고 판단했으면 true. 승인 없이 누르고, 승인은 결제 화면의 마지막 버튼에서 한 번만 받는다',
        ),
      final: z
        .boolean()
        .optional()
        .describe(
          '화면을 보고 이 버튼에서 실제로 돈이 나가거나(보내지거나·지워지거나) 확정된다고 판단했으면 true. 버튼 이름에 그런 말이 없어도 두리가 누르지 않고 승인 카드로 돌린다',
        ),
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
    'hover',
    '마우스 올리기',
    '표시(ref)한 곳에 마우스를 올려 두기만 하고 바뀐 페이지를 읽어 돌려준다. 마우스를 올려야 펼쳐지는 메뉴(카테고리 등)나 설명을 볼 때 쓴다.',
    { tabId, ref },
    true,
  )
  tool(
    'steps',
    '여러 동작 한 번에',
    '읽은 화면에서 이어지는 동작(칸 여러 개 채우기, 고르고 누르기 등)을 한 번에 차례로 하고, 끝난 뒤 페이지를 한 번만 읽어 돌려준다. 동작은 click(ref 또는 text)·type(ref, text, submit)·press(key)·hover(ref)·scroll(direction)·wait(ms)만. 다른 화면으로 넘어가거나 새 탭·확인 창이 뜨거나 막히면 거기서 멈추고 남은 동작은 하지 않는다. 결제·주문·보내기·삭제 같은 버튼은 browser_click과 똑같이 막힌다.',
    {
      tabId,
      steps: z
        .array(
          z.object({
            do: z.enum(['click', 'type', 'press', 'hover', 'scroll', 'wait']).describe('할 동작'),
            ref: ref.optional().describe('click·type·hover: 표시'),
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
    'select',
    '목록에서 고르기',
    '펼침 목록(상품의 색상·사이즈 옵션, 선택 상자, "옵션 열기"·"선택해 주세요" 칸)을 읽거나 고른다. choose 없이 부르면 목록(품절 표시·지금 골라진 것)을 돌려주고, choose에 항목 글(예: "M", "블랙")을 넣으면 그것을 고른 뒤 바뀐 페이지를 읽어 돌려준다. 스크립트로 안 열리는 목록은 두리가 진짜 마우스로 연다. 결제 수단·할부 목록에는 쓰지 않는다(승인 카드의 choices로).',
    {
      tabId,
      ref: ref.describe('목록 칸 표시 (예: e49 "옵션 열기", e51 선택 상자 "색상")'),
      choose: z
        .string()
        .max(60)
        .optional()
        .describe('고를 항목 글 (사용자가 말한 옵션, 없으면 기억한 사이즈·색). 비우면 목록만 본다'),
    },
    false,
  )
  tool(
    'scroll',
    '스크롤',
    '화면을 한 화면 위나 아래로 움직이고, 지금 화면에 보이는 부분을 읽어 돌려준다. 페이지 읽기(browser_read)는 스크롤 없이도 전체를 읽으니, 화면에 보이는 것을 따라가며 볼 때만 쓴다.',
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
    '사용자가 두리 금고에 저장해 둔 사이트면, 아이디·비밀번호 칸을 두리가 직접 채운다. 값은 보이지 않는다. 채운 뒤 로그인 버튼은 browser_click으로 누른다. 누른 뒤 화면이 로그인이 안 됐다고 말하면(틀렸다는 안내 등, 네가 판단) failed: true로 다시 불러 알린다 — 그래야 카드로 새 값을 받을 수 있다. 금고에 없으면 browser_request_login으로 로그인 카드를 띄운다.',
    {
      tabId,
      passwordRef: ref.optional().describe('비밀번호칸 표시 (예: e7). failed일 때는 생략'),
      usernameRef: ref.optional().describe('아이디 입력칸 표시. 아이디가 이미 채워져 있으면 생략'),
      failed: z
        .boolean()
        .optional()
        .describe('금고 값으로 로그인했는데 화면이 안 됐다고 말할 때 true (네가 화면을 보고 판단한다)'),
      reason: z
        .string()
        .max(80)
        .optional()
        .describe('failed일 때 화면이 한 말 (예: "비밀번호가 일치하지 않습니다")'),
    },
    false,
  )
  tool(
    'request_login',
    '로그인 카드 띄우기',
    '로그인 페이지인데 두리 금고에 그 사이트가 없을 때 쓴다(browser_login이 "금고에 없어요"라고 할 때). 사용자 폰에 로그인 카드를 띄운다. 사용자가 넣은 아이디·비밀번호는 금고에만 저장되고 너에게는 오지 않는다. 쓴 뒤에는 이번 답을 끝낸다. 로봇 확인은 그림이면 browser_request_tap, 글자면 browser_request_code(kind: captcha), 인증 앱 승인은 browser_wait_auth, 문자 인증번호는 browser_request_code로.',
    {
      tabId,
      site: z.string().max(60).describe('사용자에게 보일 사이트 이름 (예: "코스트코")'),
    },
    false,
  )
  tool(
    'fill_profile',
    '내 정보로 예약자·주문자 칸 채우기',
    '결제·예약 화면과 간편인증(정부24·홈택스 등 본인인증) 창의 이름·영문 이름·이메일·휴대폰·생년월일·주소 칸을 사용자의 "내 정보"로 두리가 직접 채운다. 간편인증 창이면 이걸로 이름·생년월일·휴대폰을 채우고, 결과에 오는 내 정보의 간편인증 앱을 눌러 [인증 요청]까지 누른 뒤 browser_wait_auth로 승인을 기다려 이어 간다(인증 앱을 대화로 묻지 않는다). 너는 칸과 항목만 짚고 값은 보지 않는다(결과에는 가린 값만). 사용자에게 이름·연락처를 묻지 말고 이걸 먼저 쓴다. 내 정보에 없는 항목이면 결과가 알려 주니 browser_request_profile로 카드를 띄운다. 칸 모양에 맞는 항목을 골라: 영문 성/이름이 따로면 name_en_last·name_en_first, 한 칸이면 name_en_full, 국가 번호를 따로 고르는 전화 칸이면 phone_local, 앞자리(010)를 따로 고르는 전화 칸이면 phone_rest(뒤 8자리), 세 칸(010-1234-5678)으로 나뉘면 앞 phone_head·가운데 phone_mid·끝 phone_last, 숫자만 받는 칸이면 phone_digits·birth_digits, 6자리 생년월일이면 birth6. 본인인증의 주민등록번호 뒷자리 칸은 rrn_back(내 정보에 있으면 바로 채우고, 없으면 폰 보안 키패드로 한 번 받아 금고에 저장 — 사용자에게 직접 넣으라고 넘기지 않는다).',
    {
      tabId,
      fields: z
        .array(
          z.object({
            ref: ref.describe('채울 입력칸 표시 (예: e12)'),
            key: z
              .enum([
                'name',
                'name_en_last',
                'name_en_first',
                'name_en_full',
                'email',
                'phone',
                'phone_digits',
                'phone_local',
                'phone_rest',
                'phone_head',
                'phone_mid',
                'phone_last',
                'rrn_back',
                'birth',
                'birth_digits',
                'birth6',
                'zip',
                'address',
                'address_detail',
              ])
              .describe('넣을 내 정보 항목'),
          }),
        )
        .min(1)
        .max(20),
    },
    false,
  )
  tool(
    'wait_auth',
    '인증 앱 승인 기다리기',
    '간편인증(카카오톡·네이버·토스·PASS 등) 요청을 보낸 뒤 쓴다. 부르기 직전에 "카카오톡(고른 앱)으로 인증 요청을 보냈어요. 승인하고 [인증 완료했어요]를 눌러 주세요"라고 한 줄 쓴다(진행 카드에 바로 보인다). 사용자 폰에 알림과 [인증 완료했어요] 카드를 띄우고 최대 3분 동안 기다린다. 기다리는 동안은 아무것도 누르지 않는다(승인 전에 누르면 인증 창을 닫는 사이트가 있다). 화면이 바뀌거나(주소·확인 창·인증 창 닫힘) 사용자가 카드를 누르면 그때 화면을 돌려주니, 됐는지는 네가 화면을 보고 판단해 이어 간다: [인증 완료]·[확인] 버튼이 있으면 누르고, 화면이 아직이라고 하면 그때만 다시 부른다. ref를 주면 사용자가 카드를 누른 순간 그 버튼을 한 번 눌러 준다. browser_handoff로 넘기고 [다 했어요]를 기다리지 않는다(그사이 인증이 만료된다).',
    {
      tabId,
      ref: ref.optional().describe('승인 뒤 누르는 [인증 완료]·[확인] 버튼 표시 (없으면 생략)'),
      message: z
        .string()
        .max(80)
        .optional()
        .describe('폰 알림에 보일 말 (예: "카카오톡에서 정부24 인증을 승인해 주세요")'),
    },
    false,
  )
  tool(
    'request_code',
    '폰에서 받아 칸에 바로 넣기 (인증번호·주민번호 뒷자리·보안문자)',
    '본인인증 화면에서 두리가 모르는 값을 사용자 폰 카드로 받아 그 칸(ref)에 바로 넣는다: 문자·카카오톡 인증번호(kind: code), 주민등록번호 뒷자리(kind: rrn_back), 결제 비밀번호 키패드(kind: pin — 먼저 key_refs로 키패드 버튼들을 주면 버튼마다 잘라 보여 준다. 그 그림을 보고 숫자마다 버튼 표시를 keys로 짚어 다시 부른다. 비밀번호는 사용자가 폰 보안 키패드로 넣고 두리가 그 버튼을 누른다. 사람에게 넘기지 않는다), 보안문자·자동입력 방지 글자(kind: captcha — 먼저 pick 없이 부르면 칸 둘레를 자른 그림 몇 장이 오니, 보안문자가 또렷한 그림 번호를 pick으로 다시 부른다. 카드에 그 그림이 함께 뜬다. 글자를 네가 읽어 넣지 않는다). 값은 너도 보지 않으며(주민번호 뒷자리는 금고에 저장돼 다음부터 browser_fill_profile의 rrn_back으로 채운다), 대화로 묻지 않는다. 사용자에게 PC에서 직접 넣으라고 넘기지 말고 이걸 쓴다. 인증번호는 이름·생년월일·휴대폰 칸을 browser_fill_profile로 채우고 [인증번호 받기]를 누른 뒤에 쓴다. 쓴 뒤에는 이번 답을 끝내고, 값이 들어가면 오는 알림을 받고 [확인]·[인증]을 눌러 이어 간다.',
    {
      tabId,
      ref: ref.describe('인증번호를 넣을 입력칸 표시'),
      label: z.string().max(40).optional().describe('카드에 보일 칸 이름 (예: "인증번호 6자리")'),
      kind: z
        .enum(['code', 'rrn_back', 'captcha', 'pin'])
        .optional()
        .describe(
          'code=인증번호(기본, 저장하지 않음) · rrn_back=주민등록번호 뒷자리(본인인증 칸, 금고에 저장) · captcha=보안문자(그림과 함께) · pin=결제 비밀번호 키패드(keys 필요)',
        ),
      keys: z
        .record(z.string(), z.string())
        .optional()
        .describe('pin일 때: 잘라 본 버튼 그림을 보고 숫자마다 그 버튼 표시 ({"0":"e20005","1":"e20003",…})'),
      key_refs: z
        .array(ref)
        .max(16)
        .optional()
        .describe(
          'pin일 때 먼저: 키패드 버튼 표시들 전부. 버튼마다 잘라 보여 주면 그걸 보고 keys를 짚어 다시 부른다',
        ),
      length: z.number().int().min(4).max(8).optional().describe('pin 자릿수 (기본 6)'),
      pick: z
        .number()
        .int()
        .min(1)
        .max(6)
        .optional()
        .describe('captcha일 때 앞서 받은 그림 중 보안문자가 또렷한 그림 번호'),
    },
    false,
  )
  tool(
    'request_tap',
    '그림 눌러 풀기 (로봇 확인)',
    '그림을 눌러 푸는 로봇 확인(지도에서 그림 위치 누르기, 신호등이 있는 칸 모두 고르기 등)을 사용자 폰 카드로 푼다. 로봇 확인 그림 자리(표시 ref, 그림에 표시가 없으면 browser_screenshot 화면에서 짚은 box)를 주면 그 자리만 잘라 폰에 그림과 안내(say)를 띄우고, 사용자가 그림에서 누른 곳을 두리가 PC 화면의 같은 자리에 차례로 누른다. 문제 글(예: "지도에서 이 그림의 위치를 눌러 주세요")은 화면에 적힌 대로 say에 넣는다. 문제 그림이 상자 밖에 따로 있으면 그것까지 들어가게 짚는다. 정답을 네가 짐작해 누르지 않는다. browser_handoff 대신 이걸 쓴다. 쓴 뒤에는 이번 답을 끝내고, 눌렀다는 알림이 오면 화면을 다시 읽어 [확인]·[제출]을 눌러 이어 간다(또 문제가 나오면 다시 부른다).',
    {
      tabId,
      ref: ref.optional().describe('로봇 확인 그림 상자 표시가 페이지에 있으면 (없으면 box)'),
      box: z
        .object({
          x: z.number().min(0).max(1000),
          y: z.number().min(0).max(1000),
          w: z.number().min(10).max(1000),
          h: z.number().min(10).max(1000),
        })
        .optional()
        .describe(
          'browser_screenshot 화면에서 문제 글·그림·지도가 다 들어가는 상자 (화면 왼쪽 위 0, 오른쪽·아래 끝 1000). 넉넉하게 짚는다',
        ),
      say: z.string().max(80).describe('카드에 보일 문제 글 (화면에 적힌 대로)'),
      taps: z
        .number()
        .int()
        .min(1)
        .max(9)
        .optional()
        .describe('누를 수 있는 곳 수 (기본 1, 칸 여러 개 고르기면 그 수까지)'),
    },
    false,
  )
  tool(
    'request_profile',
    '내 정보 카드 띄우기',
    '예약자·주문자 칸을 채워야 하는데 내 정보에 없는 항목이 있을 때 쓴다(browser_fill_profile이 "없어요"라고 할 때). 근처 찾기·출발 시간·구청·주민센터처럼 사는 곳이 필요한데 내 정보에 주소가 없을 때도 address로 이 카드를 띄운다(대화로 동네를 묻지 않는다. 한 번 넣으면 다음부터 묻지 않는다; 다른 곳이 출발지면 그때만 묻는다). 주소 없이도 되는 부분(받은 사진·서류 읽기와 평가, 일반 정보, 서울 기준 후보)은 먼저 해서 답에 넣고 카드는 그 뒤에 띄운다. 사용자에게 한 번만 넣으면 되는 내 정보 카드를 폰에 띄운다. 넣은 값은 PC 금고에만 저장되고 너에게는 가린 값만 온다. 대화로 이름·이메일·전화번호를 묻지 않는다. 카드를 띄운 뒤에도 그 정보 없이 되는 조사는 마저 하고, 결과를 답에 담아 끝낸다.',
    {
      fields: z
        .array(
          z.enum([
            'name',
            'name_en_last',
            'name_en_first',
            'email',
            'phone',
            'birth',
            'zip',
            'address',
            'address_detail',
            'auth_app',
            'carrier',
          ]),
        )
        .max(10)
        .optional()
        .describe('받을 항목. 비우면 없는 항목 모두'),
      options: z
        .array(z.string().max(20))
        .max(10)
        .optional()
        .describe(
          'auth_app을 받을 때: 그 사이트 간편인증 창에 보이는 인증 앱 이름들 (화면 글자 그대로, 예: ["카카오톡", "네이버", "토스"]). 사용자는 고르기만 한다',
        ),
      reason: z
        .string()
        .max(120)
        .optional()
        .describe('왜 필요한지 한 줄 (예: "르 도르투아 예약자 칸을 채우려고 해요")'),
    },
    false,
  )
  tool(
    'new_password',
    '새 비밀번호 만들기',
    '회원가입이나 비밀번호 찾기·변경 화면에서 "새 비밀번호" 칸을 채울 때 쓴다. 두리가 칸의 글자 수에 맞는 강한 비밀번호를 만들어 그 칸(과 확인 칸)에 넣는다. 너는 비밀번호를 받지 않는다(결과에 값이 안 온다). 금고에는 가입·변경이 끝난 화면을 두리가 본 뒤에 저장한다. 사용자가 그 사이트 가입·변경을 고르지 않았으면 두리가 폰에 먼저 묻고 아무것도 넣지 않는다(그러면 답을 끝낸다). 아이디(이메일)는 username으로 주거나, 내 정보 이메일을 쓴다. 로그인 화면의 비밀번호 칸(이미 있는 계정)에는 쓰지 않는다.',
    {
      tabId,
      password: ref.describe('새 비밀번호를 넣을 칸'),
      confirm: ref.optional().describe('비밀번호 확인 칸 (있으면)'),
      username: z
        .string()
        .max(120)
        .optional()
        .describe('가입·변경에 쓰는 아이디. 보통 이메일. 비우면 내 정보 이메일을 쓴다'),
      purpose: z
        .enum(['signup', 'reset'])
        .optional()
        .describe('signup 회원가입(기본) · reset 비밀번호 찾기·변경'),
    },
    false,
  )
  tool(
    'request_approval',
    '승인 요청',
    '돈이 나가지 않는 승인 카드: 보내기·삭제·신청(취소·반품·요금제 변경·해지 포함)·개인정보 동의처럼 승인이 필요한 버튼이면 쓴다(browser_click이나 browser_dialog가 "승인 없이는 하지 않아요"라고 할 때). 결제(돈이 나가는 마지막 버튼)에는 쓰지 않는다 — 결제는 browser_checkout(결제 카드) 하나뿐이다. 사용자가 폰에서 화면 캡처와 내용을 보고 승인하면 두리가 그 버튼만 직접 누른다. 사이트 확인 창의 [확인]이면 ref 대신 dialog: true. 고를 칸(보낼 곳·신청 유형·수거 방법 등)이 있으면 직접 고르지 말고 그 칸들의 표시를 choices에 넣어 카드에서 고르게 한다. 쓴 뒤에는 이번 답을 끝내고, 승인 알림이 오면 화면을 다시 읽어 끝난 것을 확인한다.',
    {
      tabId,
      ref: ref.optional().describe('누를 버튼 표시 (확인 창이면 생략)'),
      dialog: z.boolean().optional().describe('떠 있는 사이트 확인 창의 [확인]을 승인받을 때 true'),
      what: z.string().max(200).describe('무엇을 (예: "사과 1kg 바로 구매")'),
      where: z.string().max(100).describe('어디서 (예: "두리 시험 가게")'),
      amount: z.string().max(60).optional().describe('얼마 (페이지에 적힌 그대로, 예: "9,900원")'),
      cancel: z.string().max(200).optional().describe('취소·환불 조건 (모르면 "안내 없음")'),
      choices: z
        .array(ref)
        .max(8)
        .optional()
        .describe(
          '승인하며 사용자가 고를 칸들의 표시 (수거 방법·신청 유형 라디오 등, 예: ["e31","e32"]). 결제 수단은 browser_checkout의 choices로',
        ),
      choiceTitle: z.string().max(20).optional().describe('선택지 제목 (예: 수거 방법)'),
      chose: z
        .array(z.string().max(60))
        .max(8)
        .optional()
        .describe(
          '두리가 화면에서 스스로 고른 것 (예: ["사유: 단순 변심","약관 전체 동의","문 앞 수거"]). 사용자가 승인 카드에서 보고 바꿀 수 있게 적는다. 사용자가 고를 choices와 다르다',
        ),
      ship_to: z
        .string()
        .max(120)
        .optional()
        .describe(
          '반품 수거지·교환품 받는 곳처럼 신청에 들어가는 주소 (예: "집 · 용인시 수지구 신봉동 …, 문 앞"). 결제의 배송지는 browser_checkout의 ship_to로',
        ),
      ship_options: z
        .array(z.string().max(120))
        .max(5)
        .optional()
        .describe(
          '사이트에 저장된 다른 주소들 ([주소 변경]에 보이는 것). 사용자가 승인 카드에서 고르면 두리가 바꾼 뒤 누른다. 결제에는 browser_checkout의 ship_options로',
        ),
      count: z
        .number()
        .int()
        .min(2)
        .max(20)
        .optional()
        .describe(
          '같은 일을 여러 개 이어서 할 때 그 개수 (예: 일정 6개 지우기·메일 5통 보내기). what에 모두 적고 첫 번째 버튼으로 한 번만 승인받는다. 승인되면 남은 것은 같은 사이트에서 승인 요청 없이 이어서 누른다(10분 안). 결제에는 쓰지 않는다',
        ),
    },
    false,
  )
  tool(
    'checkout',
    '결제 카드',
    '결제를 승인받는 단 하나의 길. 결제 화면(결제 수단·최종 금액을 고르는 화면)의 마지막 결제 버튼을 누르기 전에 쓴다. 결제 화면에서 멈추고 묻지 말고, 배송지·결제 수단·쿠폰을 맞춰 마지막 버튼까지 간 뒤 이걸 부른다. 어느 결제든(쇼핑·장보기·배달·숙소·항공·티켓) 결제 화면을 읽고 아래 칸을 채우면 폰에 결제 카드 한 장이 뜨고, 사용자가 받는 곳·결제 수단을 그 카드에서 고르고 한 번 승인한다(승인은 이것 한 번뿐). 결제 화면 전 단계의 [주문하기]·[구매하기]는 browser_click(opens_checkout: true)으로 넘어가고 여기서 쓰지 않는다. 화면에 적힌 값 그대로 넣고 지어내지 않는다. 쓴 뒤에는 카드에 있는 내용을 글로 되풀이하지 말고 한두 줄(무엇을 얼마에, 확인할 점)만 말하고 답을 끝낸다. 승인 알림이 오면 두리가 누른 뒤 뜨는 결제 창(카드 고르기·다음·결제 비밀번호 키패드는 browser_request_code kind: pin)까지 같은 결제로 끝까지 마치고, 완료 화면에서 주문(예약)번호를 읽어 browser_order_done을 부른다.',
    {
      tabId,
      ref: ref.describe('마지막 버튼 표시 (결제하기·예약 완료 등)'),
      title: z
        .string()
        .max(60)
        .describe('가게·상품 묶음 이름 (예: "호호솥밥-수지점", "그랜드 하얏트 제주 · 디럭스 킹")'),
      where: z.string().max(60).describe('사이트·서비스 이름 (예: "쿠팡", "컬리")'),
      total: z.string().max(60).describe('최종 결제 금액 (화면 그대로, 예: "17,500원")'),
      goods: z
        .array(
          z.object({
            name: z.string().max(80),
            option: z.string().max(80).optional().describe('옵션·사이즈·색·객실·좌석'),
            qty: z.string().max(20).optional().describe('수량 (예: "1개", "2박", "성인 2")'),
            price: z.string().max(30).optional(),
            image: z.string().max(800).optional().describe('상품 사진 주소 (https, 화면·도구 결과 그대로)'),
          }),
        )
        .max(20)
        .describe('상품 줄'),
      lines: z
        .array(
          z.object({
            label: z.string().max(24),
            value: z.string().max(30),
            kind: z.enum(['discount', 'fee', 'point']).optional(),
          }),
        )
        .max(10)
        .optional()
        .describe('금액 줄 (상품 금액·배송비/배달료·할인·적립). 최종 금액은 total'),
      info: z
        .array(z.object({ label: z.string().max(16), value: z.string().max(160) }))
        .max(8)
        .optional()
        .describe('정보 줄 (도착 예정·이용 일시·예약자/탑승객·요청사항·좌석 등)'),
      ship_to: z.string().max(120).optional().describe('배송·배달이면 지금 골라진 받는 곳'),
      ship_options: z
        .array(z.string().max(120))
        .max(5)
        .optional()
        .describe('사이트에 저장된 다른 배송지 (배송지 바꾸기를 열어 읽은 것)'),
      choices: z
        .array(ref)
        .max(8)
        .optional()
        .describe(
          '결제 수단(또는 지금 결제·현장 결제 같은 결제 방식) 고르기 칸 표시들. 펼쳐야 보이는 수단은 미리 펼쳐 넣는다. 화면이 지금은 안 된다고 적은 수단(예: "Internet Explorer에서 가능", "앱에서만", "점검 중")은 넣지 않는다 — 사용자가 골라도 결제가 안 된다',
        ),
      choiceTitle: z.string().max(20).optional(),
      chose: z
        .array(z.string().max(60))
        .max(8)
        .optional()
        .describe('두리가 스스로 고른 것 (쿠폰 적용·보험 안 함 등)'),
      cancel: z.string().max(200).optional().describe('취소·환불·교환 규정 (화면 그대로)'),
      after: z
        .string()
        .max(120)
        .optional()
        .describe(
          '승인한 뒤 일어날 일을 화면에서 읽은 대로 (예: 고른 결제 수단이 네이버페이·카카오페이·토스처럼 결제 창으로 넘어가면 "네이버페이 창에서 결제 비밀번호를 폰 키패드로 받아요", 만나서 결제면 "누르면 바로 주문이 들어가요"). 사용자가 누르면 무슨 일이 생기는지 알게',
        ),
      final_here: z
        .boolean()
        .optional()
        .describe('결제 화면이 따로 없고 이 화면의 버튼에서 바로 돈이 나갈 때 true (없어도 카드는 뜬다)'),
    },
    false,
  )
  tool(
    'order_done',
    '주문 완료 알리기',
    '승인한 결제가 끝났을 때 쓴다: 주문(예약) 완료 화면에서 주문번호를 읽었으면 order_no와 함께 부른다. 두리가 결제 묶음(결제 중인 탭·결제 창)을 풀고 결제 승인을 주문번호와 함께 완료로 바꾼다. 그 뒤 show_result로 결과를 보여 주고 know_save로 남긴다. 결제가 안 됐으면(거절·시간 초과·오류) failed: true와 reason으로 부르고, 돈이 나갔는지 확인한 뒤 다른 길로 다시 한다.',
    {
      tabId,
      order_no: z
        .string()
        .max(60)
        .optional()
        .describe('주문·예약 번호 (완료 화면에 적힌 그대로). failed가 아니면 꼭 넣는다'),
      summary: z
        .string()
        .max(200)
        .optional()
        .describe('무엇을 얼마에 (예: "사과 1kg 9,900원 · 11/22 도착 예정")'),
      failed: z.boolean().optional().describe('결제를 마치지 못했으면 true'),
      reason: z.string().max(200).optional().describe('failed일 때 화면이 말한 까닭'),
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
    '비상 전용(emergency: true일 때만): 사용자가 폰에서 PC 화면을 직접 열어 만지게 한다. 사용자는 PC 화면 넘기기를 원하지 않는다. 사람 몫은 모두 폰 카드로 받는다 — 이름·연락처·생년월일·주민번호 뒷자리는 browser_fill_profile, 인증번호·결제 비밀번호 키패드·인증서 비밀번호는 browser_request_code, 로봇 확인은 browser_request_tap(그림)·browser_request_code(kind: captcha, 글자), 인증 앱 승인은 browser_wait_auth, 아이디·비밀번호는 browser_request_login, 결제는 browser_checkout, 보내기·삭제·동의는 browser_request_approval. 이걸로 안 되는, 사람만 넣을 수 있는 칸(예: 저장된 카드가 없어 새 카드 번호를 처음 넣는 칸)일 때만 쓴다. 같은 화면에서 처음 부르면 넘기지 않고 화면을 다시 읽어 돌려준다(할 수 있으면 직접 하고, 정말 필요하면 다시 부른다). 두리 탭을 사용자 앞에 띄우고 무엇을 해 달라는지 알린다. 쓴 뒤에는 이번 답을 끝낸다.',
    {
      tabId,
      reason: z
        .string()
        .max(200)
        .describe(
          '사용자에게 보일 부탁 (예: "저장된 카드가 없어요. 새 카드 번호만 넣어 주시면 나머지는 두리가 할게요")',
        ),
      emergency: z
        .boolean()
        .optional()
        .describe(
          '폰 카드(request_code·request_tap·checkout·fill_profile)로는 정말 안 되는 비상일 때만 true. 없으면 넘기지 않는다',
        ),
    },
    false,
  )
  tool('close', '탭 닫기', '다 쓴 두리 탭을 닫는다. 일이 끝나면 연 탭을 닫는다.', { tabId }, false)
}
