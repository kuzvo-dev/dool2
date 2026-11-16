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
        '사용자가 "쿠팡 연결해 줘"라고 하거나, 하려는 일에 연결(로그인)이 안 된 서비스가 필요하면 쓴다. ' +
        '대화에 그 서비스의 [연결하기] 카드를 띄운다. 사용자가 카드에 아이디·비밀번호를 넣으면 두리 본체가 PC Chrome에서 대신 로그인하고, ' +
        '끝나면 대화로 알림이 온다. 아이디·비밀번호를 대화로 묻거나 받지 않는다. 카드를 띄웠다고 짧게 말하고 기다린다.',
      inputSchema: {
        service: z.string().max(60).describe('연결 카드 id나 서비스 이름 (예: "coupang", "쿠팡", "KT")'),
      },
    },
    call('connect_ask'),
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
