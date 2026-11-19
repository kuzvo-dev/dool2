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
    '로그인 페이지인데 두리 금고에 그 사이트가 없을 때 쓴다(browser_login이 "금고에 없어요"라고 할 때). 사용자에게 PC·폰 대화 안 로그인 카드를 띄운다. 사용자가 넣은 아이디·비밀번호는 금고에만 저장되고 너에게는 오지 않는다. 쓴 뒤에는 이번 답을 끝낸다. 로봇 확인·인증 앱 승인은 browser_handoff로, 문자 인증번호는 browser_request_code로.',
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
    '간편인증(카카오톡·네이버·토스·PASS 등) 요청을 보낸 뒤 쓴다. 부르기 직전에 "카카오톡(고른 앱)으로 인증 요청을 보냈어요. 3분 안에 승인해 주세요"라고 한 줄 쓴다(진행 카드에 바로 보인다). 사용자 폰에 "인증 앱에서 승인해 주세요" 알림을 보내고, 최대 3분 동안 몇 초마다 그 화면의 [인증 완료]·[확인] 버튼(ref)을 눌러 승인됐는지 확인한다. 승인되면 다음 화면을 돌려주니 그대로 이어 간다. browser_handoff로 넘기고 [다 했어요]를 기다리지 않는다(그사이 인증이 만료된다). 버튼 없이 저절로 넘어가는 화면이면 ref를 비운다.',
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
    '폰에서 받아 칸에 바로 넣기 (인증번호·주민번호 뒷자리)',
    '본인인증 화면에서 두리가 모르는 값을 사용자 폰 카드로 받아 그 칸(ref)에 바로 넣는다: 문자·카카오톡 인증번호(kind: code), 주민등록번호 뒷자리(kind: rrn_back). 값은 너도 보지 않으며(주민번호 뒷자리는 금고에 저장돼 다음부터 browser_fill_profile의 rrn_back으로 채운다), 대화로 묻지 않는다. 사용자에게 PC에서 직접 넣으라고 넘기지 말고 이걸 쓴다. 인증번호는 이름·생년월일·휴대폰 칸을 browser_fill_profile로 채우고 [인증번호 받기]를 누른 뒤에 쓴다. 쓴 뒤에는 이번 답을 끝내고, 값이 들어가면 오는 알림을 받고 [확인]·[인증]을 눌러 이어 간다.',
    {
      tabId,
      ref: ref.describe('인증번호를 넣을 입력칸 표시'),
      label: z.string().max(40).optional().describe('카드에 보일 칸 이름 (예: "인증번호 6자리")'),
      kind: z
        .enum(['code', 'rrn_back'])
        .optional()
        .describe(
          'code=인증번호(기본, 저장하지 않음) · rrn_back=주민등록번호 뒷자리(본인인증 칸, 금고에 저장)',
        ),
    },
    false,
  )
  tool(
    'request_profile',
    '내 정보 카드 띄우기',
    '예약자·주문자 칸을 채워야 하는데 내 정보에 없는 항목이 있을 때 쓴다(browser_fill_profile이 "없어요"라고 할 때). 사용자에게 한 번만 넣으면 되는 내 정보 카드를 폰에 띄운다. 넣은 값은 PC 금고에만 저장되고 너에게는 가린 값만 온다. 대화로 이름·이메일·전화번호를 묻지 않는다. 쓴 뒤에는 이번 답을 끝낸다.',
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
    '결제·주문·예약 확정·보내기·삭제처럼 승인이 필요한 버튼이면 쓴다(browser_click이나 browser_dialog가 "승인 없이는 하지 않아요"라고 할 때). 결제는 결제 화면(최종 금액·결제 수단·예약자 정보가 보이는 화면)의 마지막 버튼에 쓰고, 결제 화면을 여는 [예약하기]·[구매하기]에는 쓰지 않는다. 사용자가 PC나 폰에서 화면 캡처와 내용을 보고 승인하면 두리가 그 버튼만 직접 누른다. 사이트 확인 창의 [확인]이면 ref 대신 dialog: true. 결제 화면에 결제 수단(네이버페이·카드 등)이나 "지금 결제·숙박 시설에서 결제" 같은 고를 칸이 있으면 직접 고르지 말고 그 칸들의 표시를 choices에 넣는다. 사용자가 승인 카드에서 고르면 두리가 그걸 고른 뒤 마지막 버튼을 누른다. 쓴 뒤에는 이번 답을 끝낸다.',
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
        .describe('승인하며 사용자가 고를 칸들의 표시 (결제 수단 라디오 등, 예: ["e31","e32"])'),
      choiceTitle: z.string().max(20).optional().describe('선택지 제목 (기본: 결제 수단)'),
      chose: z
        .array(z.string().max(60))
        .max(8)
        .optional()
        .describe(
          '결제 전에 두리가 화면에서 스스로 고른 것 (예: ["여행자보험 가입 안 함","약관 전체 동의","적립 안 함"]). 사용자가 승인 카드에서 보고 바꿀 수 있게 적는다. 사용자가 고를 choices와 다르다',
        ),
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
    '마지막 수단: 사용자가 폰에서 PC 화면을 직접 열어 만지게 한다(번거롭다). 먼저 폰 카드로 끝낼 수 있는지 본다 — 이름·연락처·생년월일·주민번호 뒷자리는 browser_fill_profile, 문자 인증번호는 browser_request_code, 인증 앱 승인은 browser_wait_auth, 아이디·비밀번호는 browser_request_login, 고를 것·결제·보내기·삭제는 browser_request_approval, 맡긴 일에 필요한 개인정보 동의는 browser_click. 이걸로 안 되는 로봇 확인(캡차)·공동인증서 비밀번호·화면에서만 되는 조작일 때만 쓴다. 두리 탭을 사용자 앞에 띄우고 무엇을 해 달라는지 알린다. 쓴 뒤에는 이번 답을 끝낸다.',
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
