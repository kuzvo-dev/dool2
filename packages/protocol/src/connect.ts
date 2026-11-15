// 서비스 연결 카드 (skills/<id>/connect.json, ADR 0014).
// 연결 화면(목록·상세)에 보일 내용과 두리가 그 서비스에서 할 수 있는 일을 적은 템플릿이다.
// 서비스를 하나 더하려면 폴더 하나에 이 파일 하나를 넣으면 된다. 코드는 바꾸지 않는다.
import { z } from 'zod'
import { APPROVAL_TIERS, approvalLine, CATEGORY_LABEL } from './connect-text.js'

export { APPROVAL_TIERS, approvalLine }

/** 권한 등급 (docs/architecture.md 4.1). 돈 내기·연락하기는 폰 승인이 있어야만 실행된다 */
export const TierSchema = z.enum(['찾아보기', '채워 두기', '돈 내기', '연락하기'])
export type Tier = z.infer<typeof TierSchema>

/** 연결 화면의 분류 (connect-text.ts의 CATEGORY_LABEL). 순서가 곧 목록 순서다 */
export const CONNECT_CATEGORIES = CATEGORY_LABEL
export const ConnectCategorySchema = z.enum(
  Object.keys(CONNECT_CATEGORIES) as [
    keyof typeof CONNECT_CATEGORIES,
    ...(keyof typeof CONNECT_CATEGORIES)[],
  ],
)
export type ConnectCategory = z.infer<typeof ConnectCategorySchema>

/**
 * 연결 방식 (docs/architecture.md 5.0 "가장 정확한 방법부터")
 * - browser: 사용자의 Chrome에서 한 번 로그인해 두면 두리가 그 화면으로 일한다 (대부분)
 * - official: 공식 연동(메일 IMAP·캘린더 API 등)이 있는 곳. 준비되기 전에는 browser처럼 쓴다
 * - open: 로그인 없이 쓰는 곳 (택배 조회 등)
 * - device: 폰 권한 (연락처·위치·캘린더). 폰 앱에서 켠다
 */
export const ConnectHowSchema = z.enum(['browser', 'official', 'open', 'device'])
export type ConnectHow = z.infer<typeof ConnectHowSchema>

const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !s.includes('\n'), '한 줄로 적어 주세요')

export const ConnectAbilitySchema = z
  .object({
    /** 짧은 이름: "배송 조회" */
    title: line(20),
    /** 사용자가 할 법한 말, 따옴표 없이: "주문한 거 언제 와?" */
    say: line(40).refine((s) => !/^["“'‘]|["”'’]$/.test(s), '따옴표는 빼고 적어 주세요 (화면이 붙여요)'),
    tier: TierSchema,
  })
  .strict()
export type ConnectAbility = z.infer<typeof ConnectAbilitySchema>

export const ConnectCardSchema = z
  .object({
    /** 폴더 이름과 같게. 영어 소문자·숫자·- */
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
    name: line(24),
    /** 주소창의 도메인 (https:// 없이): "coupang.com". 아이콘·로그인 확인에 쓴다. 폰 권한이면 생략 */
    site: z
      .string()
      .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'https:// 없이 도메인만 적어 주세요')
      .optional(),
    category: ConnectCategorySchema,
    how: ConnectHowSchema,
    /** 연결할 때 사용자가 하는 로그인: "아이디·비밀번호", "카카오·네이버 간편 로그인" */
    login: line(40).optional(),
    /** 상세 화면 첫 문단. "~하면 ~까지 두리에게 맡길 수 있어요." 한두 문장 */
    summary: z.string().trim().min(10).max(140),
    /** 상세 화면의 대화 예시 */
    example: z
      .object({
        ask: line(50),
        /** 일하는 동안 보이는 말: "배송 조회 중" */
        working: line(20),
        reply: z.string().trim().min(5).max(120),
      })
      .strict(),
    abilities: z.array(ConnectAbilitySchema).min(2).max(6),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.how !== 'device' && !c.site)
      ctx.addIssue({ code: 'custom', path: ['site'], message: '도메인(site)이 필요해요' })
    if (c.how === 'browser' && !c.login)
      ctx.addIssue({ code: 'custom', path: ['login'], message: '어떻게 로그인하는지(login) 적어 주세요' })
  })
export type ConnectCard = z.infer<typeof ConnectCardSchema>

/** 카드 문제를 사람이 읽을 수 있는 목록으로 (스킬 검사 테스트·기여 안내에서 쓴다) */
export function checkConnectCard(dir: string, raw: unknown): string[] {
  const r = ConnectCardSchema.safeParse(raw)
  const problems = r.success ? [] : r.error.issues.map((i) => `${i.path.join('.') || '(전체)'}: ${i.message}`)
  if (r.success && r.data.id !== dir) problems.push(`id(${r.data.id})가 폴더 이름(${dir})과 달라요`)
  return problems
}

/** 연결 화면 한 줄: 카드 + 절차 문서 상태 + 연결 상태 (GET /api/connections) */
export interface ConnectionItem {
  card: ConnectCard
  /** SKILL.md가 있으면 그 상태 (초안 / 검증됨(날짜) / 막힘(사유)) */
  skill?: string
  /** 사용자가 연결을 마친 시각. open·device는 연결 없이 쓰거나 폰에서 켠다 */
  connectedAt?: string
}

/** 서비스 첫 화면 주소 (연결할 때 Chrome에서 연다) */
export function connectUrl(card: Pick<ConnectCard, 'site'>): string | undefined {
  return card.site ? `https://${card.site}/` : undefined
}
