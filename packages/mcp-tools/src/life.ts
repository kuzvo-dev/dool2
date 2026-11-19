// 두리의 생활 도구: 목표·알아서 하는 일, 보관함, 기억, 피드. 실제 저장은 두리 본체가 한다.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { BrowserClient } from './browser.js'

const time = z
  .string()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/)
  .describe('한국 시간 HH:MM (예: "07:30")')

export function registerLifeTools(server: McpServer, client: BrowserClient) {
  const call = (tool: string) => async (args: Record<string, unknown>) => {
    const r = await client(tool, args)
    return { content: r.content, ...(r.isError ? { isError: true } : {}) }
  }
  server.registerTool(
    'goal_create',
    {
      title: '목표·알아서 할 일 만들기',
      description:
        '사용자가 정해진 때 두리가 알아서 할 일(알림, 아침 브리핑, 매주 요약, 가격·취소표 지켜보기)이나 장기 목표(운동, 저축, 공부)를 말하면 만든다. ' +
        '알림도 이것으로 만든다("내일 10시에 치과 전화 알려 줘" → once). 목표는 category와 plan(3~6단계)을 함께 주고, 체크인 때를 schedule로 준다. ' +
        '만든 뒤에는 무엇을 언제 할지 사용자에게 한 번 더 확인해 말한다. 지난 시각이면 만들지 말고 다른 시각을 물어본다.',
      inputSchema: {
        title: z
          .string()
          .max(60)
          .describe('짧은 이름 (예: "아침 브리핑", "매달 휴대폰 요금 확인", "주 3회 운동")'),
        prompt: z
          .string()
          .max(1000)
          .describe(
            '그때 두리가 할 일을 두리에게 하는 말로 (예: "오늘 날씨와 일정, 오는 택배를 짧게 정리해 줘")',
          ),
        schedule: z
          .enum(['daily', 'weekly', 'once', 'every'])
          .optional()
          .describe('daily=매일, weekly=요일마다, once=한 번, every=N분마다. 정한 때가 없는 목표면 생략'),
        time: time.optional(),
        days: z.array(z.number().int().min(0).max(6)).optional().describe('weekly일 때 요일 (0=일 … 6=토)'),
        at: z
          .string()
          .optional()
          .describe('once일 때 ISO 시각 (한국 시간 +09:00 포함, 예: "2026-11-20T10:00:00+09:00")'),
        minutes: z.number().int().min(15).optional().describe('every일 때 간격(분, 15 이상)'),
        category: z
          .enum(['건강', '관계', '돈', '일', '관심사', '생산성', '기타'])
          .optional()
          .describe('장기 목표일 때만'),
        plan: z.array(z.string().max(120)).max(12).optional().describe('목표의 계획 단계'),
        target: z
          .enum(['chat', 'feed'])
          .optional()
          .describe('결과를 대화(기본)에 말할지, 피드에 글로 올릴지'),
      },
    },
    call('goal_create'),
  )
  server.registerTool(
    'goal_list',
    {
      title: '목표·예정 보기',
      description:
        '만들어 둔 목표와 알아서 하는 일, 다음 시각, 지난 결과를 본다. "무슨 알림 예약했지?"에 쓴다.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    call('goal_list'),
  )
  server.registerTool(
    'goal_update',
    {
      title: '목표 고치기',
      description:
        '목표의 계획 단계를 새로 쓰거나(plan), 끝낸 단계를 표시하거나(done: 단계 번호, 0부터), 진행 기록을 남긴다(log).',
      inputSchema: {
        id: z.string().max(40).describe('goal_list의 id (앞 8자도 됨)'),
        title: z.string().max(60).optional(),
        plan: z.array(z.string().max(120)).max(12).optional(),
        done: z.array(z.number().int().min(0)).optional(),
        log: z.string().max(300).optional().describe('이번 체크인에서 알게 된 진행 상황 한두 문장'),
      },
    },
    call('goal_update'),
  )
  server.registerTool(
    'goal_delete',
    {
      title: '목표·예정 지우기',
      description: '사용자가 그만하라고 한 목표나 알림을 지운다.',
      inputSchema: { id: z.string().max(40).describe('goal_list의 id (앞 8자도 됨)') },
    },
    call('goal_delete'),
  )
  server.registerTool(
    'library_save',
    {
      title: '보관함에 남기기',
      description:
        '사용자에게 다시 쓸 만한 결과를 보관함에 남긴다: 정리한 글·비교표(note), 찾은 링크(link), 상품(product, 가격 포함), 장소(place). ' +
        '여러 상품을 비교했거나, 일정·목록을 만들었거나, 사용자가 "저장해 둬"라고 하면 쓴다.',
      inputSchema: {
        kind: z.enum(['note', 'link', 'product', 'place', 'file']),
        title: z.string().max(80),
        body: z.string().max(4000).describe('내용 (마크다운 목록·굵게 가능)'),
        url: z.string().max(500).optional(),
        price: z.string().max(40).optional().describe('상품 가격 (예: "15,900원")'),
      },
    },
    call('library_save'),
  )
  server.registerTool(
    'memory_save',
    {
      title: '기억하기',
      description:
        '사용자에 대해 앞으로도 도움이 될 사실을 기억한다: 이름·호칭, 사는 동네, 가족, 자주 가는 곳, 좋아하는 것, 쓰는 서비스, 일정 습관. ' +
        '한 번에 한 문장. 비밀번호·카드 번호·주민번호 같은 민감한 값은 절대 기억하지 않는다.',
      inputSchema: {
        text: z.string().max(200).describe('예: "아이가 둘 (초3 딸, 6살 아들)", "출퇴근은 동탄역에서 SRT"'),
      },
    },
    call('memory_save'),
  )
  server.registerTool(
    'memory_forget',
    {
      title: '잊기',
      description: '사용자가 잊어 달라고 하거나 틀린 기억을 지운다.',
      inputSchema: { text: z.string().max(200).describe('지울 기억의 내용 일부나 id') },
    },
    call('memory_forget'),
  )
  server.registerTool(
    'idea_suggest',
    {
      title: '맞춤 아이디어 올리기',
      description:
        '사용자에게 지금 해 주면 좋을 일 3~6개를 아이디어 탭 맨 위에 올린다. 기억·목표·연결한 서비스·최근 대화를 보고, 실제로 두리가 할 수 있는 구체적인 일만 고른다.',
      inputSchema: {
        ideas: z
          .array(
            z.object({
              text: z
                .string()
                .max(120)
                .describe('누르면 그대로 보낼 부탁 (예: "이번 주 금요일 저녁 부산 가는 SRT 자리 찾아 줘")'),
              why: z.string().max(120).describe('왜 지금 이게 좋은지 한 줄 (예: "주말마다 부산에 가셨어요")'),
            }),
          )
          .min(1)
          .max(6),
      },
    },
    call('idea_suggest'),
  )
  server.registerTool(
    'photo_view',
    {
      title: '보낸 사진 보기',
      description:
        '사용자 말 끝에 "[사진: 파일이름.jpg]"가 있으면 그 사진을 본다. 영수증·캡처·상품 사진을 읽고 정리할 때 쓴다.',
      inputSchema: { name: z.string().max(80).describe('사진 파일 이름 (예: 2026-11-16T01-30-00-000Z.jpg)') },
      annotations: { readOnlyHint: true },
    },
    call('photo_view'),
  )
  server.registerTool(
    'connect_ask',
    {
      title: '서비스 연결 카드 띄우기',
      description:
        '사용자가 "쿠팡 연결해 줘"라고 하거나, 하려는 일의 다음 단계에 로그인이 꼭 필요할 때(예약·주문·내 내역 보기) 쓴다. ' +
        '찾기·비교·빈자리 보기처럼 로그인 없이 되는 일은 먼저 그 서비스에서 해서 후보를 보여 준 뒤, 고르면 그때 띄운다. ' +
        '대화에 그 서비스의 [연결하기] 카드를 띄운다. 사용자가 카드에 아이디·비밀번호를 넣으면 두리 본체가 PC Chrome에서 대신 로그인하고, ' +
        '끝나면 대화로 알림이 온다. 아이디·비밀번호를 대화로 묻거나 받지 않는다. 카드를 띄웠다고 짧게 말하고 기다린다.',
      inputSchema: {
        service: z.string().max(60).describe('연결 카드 id나 서비스 이름 (예: "coupang", "쿠팡", "KT")'),
      },
    },
    call('connect_ask'),
  )
  server.registerTool(
    'show_cards',
    {
      title: '답에 카드 붙이기',
      description:
        '상품·숙소·식당·공연처럼 고를 후보를 보여 줄 때 답 아래에 사진 카드로 붙인다 (옆으로 넘겨 보고, 누르면 그 페이지, [이걸로]를 누르면 고른 게 대화로 온다). ' +
        '서비스 도구 결과에 있는 사진(image)·주소(link)·가격을 그대로 넣는다. 지어낸 주소·사진은 넣지 않는다. 2~8장, 추천 순서대로. ' +
        '카드를 붙였으면 답 글에는 같은 목록·표를 다시 늘어놓지 말고 고른 이유와 차이만 2~4문장으로 말한다.',
      inputSchema: {
        cards: z
          .array(
            z.object({
              title: z.string().max(80).describe('이름 (예: "쿠진아트 스팀 에어프라이어 오븐 CSO-500KR")'),
              image: z.string().max(800).optional().describe('사진 주소 (https, 도구 결과의 image 그대로)'),
              price: z.string().max(40).optional().describe('가격 한 줄 (예: "350,100원", "1박 112,260원")'),
              note: z.string().max(60).optional().describe('짧은 정보 (예: "★4.8 (1,203) · 내일 도착")'),
              url: z
                .string()
                .max(800)
                .optional()
                .describe('눌렀을 때 열 주소 (https, 도구 결과의 link 그대로)'),
              badge: z.string().max(12).optional().describe('눈에 띌 말 (예: "최저가", "추천")'),
            }),
          )
          .min(1)
          .max(10),
        shape: z
          .enum(['square', 'portrait'])
          .optional()
          .describe(
            '사진 모양: 영화 포스터·책 표지·공연 포스터는 portrait(세로), 그 밖(상품·숙소·식당)은 square',
          ),
      },
    },
    call('show_cards'),
  )
  // 결과 블록 (docs/design/system/components/ChatBlocks). 답 하나에 결과 블록 하나: 여러 번 부르면 마지막 것만 붙는다
  const blockAction = z.object({
    label: z.string().max(16).describe('버튼 이름, 동사로 (예: "캘린더에 넣기", "담기", "예약 보기")'),
    ask: z
      .string()
      .max(300)
      .optional()
      .describe('누르면 사용자 말로 두리에게 갈 부탁 (예: "이 일정 3개 캘린더에 넣어 줘")'),
    url: z.string().max(800).optional().describe('ask 대신 열 주소 (https, 도구 결과 그대로)'),
  })
  server.registerTool(
    'show_list',
    {
      title: '답에 목록 줄 붙이기',
      description:
        '사진이 고르는 이유가 아닌 목록(매물·주문·메일·일정·마감·서류·공고·신청 내역)을 답 아래에 줄로 붙인다. ' +
        '사진이 고르는 이유면(상품·숙소·식당·포스터) show_cards를 쓴다. 3줄 넘는 목록을 글로 늘어놓는 대신 쓴다. ' +
        '앞머리(lead)로 모양을 고른다: date 날짜(일정·마감, date 칸 필수) · file 파일(받은 서류·만든 파일) · img 작은 사진 · logo 서비스 로고 · none. ' +
        'pick: one이면 줄을 누르면 그걸로 고른 게 대화로 온다(하나 고르기). ' +
        'pick: multi는 여러 개를 한 번에 고를 때(장보기 담기·선물 후보·받을 서류): 두리가 고른 건 on을 비우고(기본 체크), 애매한 건 on:false로 꺼 두고 sub에 이유. ' +
        'amount(원)를 다 넣으면 버튼에 "3개 담기 · 25,860원"처럼 합계가 보인다. 버튼(action)은 목록 전체에 할 일 하나(예: "캘린더에 넣기"). ' +
        '돈·연락·삭제는 버튼이 바로 하지 않는다 — 누르면 부탁이 오고, 그때 승인을 받는다. 지어낸 값은 넣지 않는다. ' +
        '붙였으면 답 글에는 같은 목록을 되풀이하지 말고 이유·다음 할 일만 2~4문장으로.',
      inputSchema: {
        title: z
          .string()
          .max(40)
          .optional()
          .describe('머리 줄 (예: "공덕초 · 2026학년도", "컬리 · 내일 아침 7시 전 도착")'),
        from: z.string().max(24).optional().describe('머리 오른쪽 작은 글: 출처·건수 (예: "46건", "홈택스")'),
        lead: z.enum(['img', 'date', 'file', 'logo', 'none']).optional(),
        pick: z.enum(['one', 'multi']).optional(),
        rows: z
          .array(
            z.object({
              title: z.string().max(60),
              sub: z
                .string()
                .max(60)
                .optional()
                .describe('작은 줄 (예: "21분 전 · 직거래 마포", "2개 · 작년 1개")'),
              value: z.string().max(20).optional().describe('오른쪽 굵은 값 (예: "3만 원", "15,960원")'),
              valueNote: z.string().max(24).optional().describe('값 아래 작은 글 (예: "7,980원 × 2")'),
              state: z
                .string()
                .max(12)
                .optional()
                .describe('오른쪽 상태 글자 (예: "받음", "배송 중", "1/15쯤")'),
              tone: z
                .enum(['done', 'wait', 'stop'])
                .optional()
                .describe('상태 색: done 끝남 · wait 기다림·마감 · stop 멈춤'),
              image: z.string().max(800).optional().describe('작은 사진 (https, 도구 결과 그대로)'),
              date: z.string().max(10).optional().describe('YYYY-MM-DD (lead가 date일 때)'),
              file: z.string().max(5).optional().describe('파일 종류 (예: "PDF")'),
              url: z.string().max(800).optional().describe('줄을 누르면 열 주소 (https)'),
              on: z.boolean().optional().describe('pick multi: false면 꺼 둔다'),
              amount: z.number().optional().describe('pick multi 합계용 금액(원, 수량 곱한 값)'),
            }),
          )
          .min(1)
          .max(30),
        action: blockAction.optional(),
      },
    },
    call('show_list'),
  )
  server.registerTool(
    'show_result',
    {
      title: '답에 결과 한 장 붙이기',
      description:
        '값 하나가 답인 결과를 답 아래 카드 한 장으로 붙인다: 끝난 증거(예약·주문·신청 완료와 번호), 금액 합계(카드값·요금·환급금), ' +
        '배송·신청·심사 단계, 마감·기한. 큰 값(big)은 언제·얼마 하나. 정보 줄(facts)은 3~6개, 번호는 code. ' +
        '단계(steps)는 단계 이름과 지금 단계 번호(0부터). 기한(due)을 주면 D-날짜가 노랑으로 보인다. ' +
        '끝난 일(done)은 끝난 화면을 다시 읽어 확인한 값만 넣는다 — 지어낸 번호·금액 금지. 버튼은 2개까지(마지막이 주 버튼). ' +
        '붙였으면 답 글에는 같은 값을 되풀이하지 말고 한두 문장만.',
      inputSchema: {
        title: z
          .string()
          .max(40)
          .optional()
          .describe('머리 줄 (예: "예약 확정", "쿠팡 · 접이식 유모차", "신한카드 · 12월 청구")'),
        from: z.string().max(24).optional().describe('머리 오른쪽 출처 (예: "캐치테이블", "CJ대한통운")'),
        done: z.boolean().optional().describe('끝난 일이면 true (머리에 체크)'),
        big: z.string().max(40).describe('큰 값 하나 (예: "11/21(토) 19:00", "1,284,300원", "오늘 14~16시")'),
        bigNote: z.string().max(24).optional().describe('큰 값 옆 작은 글 (예: "4명 · 룸", "도착 예정")'),
        facts: z
          .array(
            z.object({
              label: z.string().max(14),
              value: z.string().max(40),
              code: z.boolean().optional().describe('번호면 true (고정폭 글꼴)'),
            }),
          )
          .max(6)
          .optional(),
        steps: z
          .object({
            names: z.array(z.string().max(10)).min(2).max(6).describe('예: ["주문","출고","배송 중","도착"]'),
            now: z.number().int().min(0).describe('지금 단계 번호 (0부터)'),
          })
          .optional(),
        due: z.string().max(10).optional().describe('기한 YYYY-MM-DD'),
        dueLabel: z.string().max(8).optional().describe('기한 꼬리표 말 (예: "결제", "마감")'),
        actions: z.array(blockAction).max(2).optional(),
      },
    },
    call('show_result'),
  )
  server.registerTool(
    'show_draft',
    {
      title: '답에 보낼 글 붙이기',
      description:
        '글자 그대로 쓰일 글(문자·카톡·메일·민원·후기·게시글)을 답 아래에 붙인다. 사용자는 [복사]하거나 [보내기]를 누른다. ' +
        '[보내기]를 누르면 "방금 쓴 글 그대로 보내 줘"가 대화로 오고, 그때 보내기 직전 승인을 받는다(이 도구는 보내지 않는다). ' +
        '사용자가 말하지 않은 사실은 넣지 않고 [날짜]처럼 빈칸으로. 붙였으면 답 글에는 글을 되풀이하지 말고 한두 문장만.',
      inputSchema: {
        to: z.string().max(30).optional().describe('받는 사람 (예: "집주인 김OO", "OO구청 민원실")'),
        via: z
          .enum(['sms', 'kakao', 'mail', 'post', 'other'])
          .describe('보낼 방법: 문자·카톡·메일·게시(민원·후기)·그 밖'),
        subject: z.string().max(80).optional().describe('메일 제목 (via가 mail일 때)'),
        text: z.string().max(2000).describe('보낼 글 그대로'),
      },
    },
    call('show_draft'),
  )
  server.registerTool(
    'feed_post',
    {
      title: '피드에 올리기',
      description:
        '대화로 말할 정도는 아니지만 알아 두면 좋은 소식을 피드에 짧은 글로 올린다 (피드 지시·목표 체크인 결과 등).',
      inputSchema: {
        title: z.string().max(80),
        body: z.string().max(1500).describe('핵심 3~5줄. 확인한 것만'),
      },
    },
    call('feed_post'),
  )
  server.registerTool(
    'feed_tell',
    {
      title: '먼저 챙긴 일 알리기',
      description:
        '사용자가 묻지 않았지만 지금 알면 좋을 일을 비서처럼 먼저 알린다. 피드 맨 위에 올라가고 폰에도 알림이 간다. ' +
        '연결한 서비스에서 직접 확인한 새 소식만 (배송·도착 예정, 다가오는 예약·일정, 답이 필요한 메일, 기록·결과 발표, 결제·만료 예정, 기억해 둔 기념일 등). ' +
        '짐작이나 광고·일반 상식은 올리지 않는다. 같은 일은 key가 같으면 다시 올라가지 않는다. 살펴보기 한 번에 3개까지. ' +
        '두리가 이어서 해 줄 수 있는 일이 있으면 ask에 사용자가 [해 줘]를 눌렀을 때 보낼 부탁을 적는다 (돈 내기·보내기는 여기서 하지 않고 ask로 제안만).',
      inputSchema: {
        title: z
          .string()
          .min(1)
          .max(80)
          .describe('알림 한 줄, 두리 말투 (예: "어제 주문한 러닝화, 내일 오전에 도착해요")'),
        body: z.string().max(600).optional().describe('덧붙일 한두 문장 (예: "문 앞에 두고 간대요")'),
        from: z.string().max(60).optional().describe('어디서 알았는지 (예: "쿠팡 주문 내역을 보고")'),
        key: z
          .string()
          .min(1)
          .max(120)
          .describe('같은 일을 또 알리지 않을 열쇠: 서비스-대상-상태 (예: "coupang-주문12345-도착예정")'),
        ask: z
          .string()
          .max(300)
          .optional()
          .describe(
            '[해 줘]를 누르면 두리에게 보낼 부탁 (예: "엄마 생신 선물 3만 원대로 골라 줘"). 알리기만 하면 비운다',
          ),
        ask_label: z.string().max(12).optional().describe('[해 줘] 버튼 글자 (예: "골라 줘")'),
      },
    },
    call('feed_tell'),
  )
  server.registerTool(
    'conversation_search',
    {
      title: '지난 대화 찾기',
      description:
        '사용자와 예전에 나눈 대화를 찾는다. 사용자가 앞에서 한 이야기("지난주에 본 청소기 뭐였지?", "그때 말한 식당")를 꺼냈는데 ' +
        '지금 기억(앞 대화 요약·최근 대화)에 없으면 짐작하지 말고 이것으로 먼저 찾아본다. ' +
        '날짜(한국 시간)·누가 한 말인지와 함께 짧은 글이 온다. 맞는 게 없으면 낱말을 바꿔 한 번 더 찾는다.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(100)
          .describe('찾을 낱말 1~3개 (예: "청소기", "부산 SRT", "국밥집"). 문장 대신 핵심 낱말로'),
        limit: z.number().int().min(1).max(20).optional().describe('최대 몇 개 (기본 10)'),
      },
      annotations: { readOnlyHint: true },
    },
    call('conversation_search'),
  )
}
