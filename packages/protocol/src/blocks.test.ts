import { describe, expect, it } from 'vitest'
import {
  blockText,
  cleanDraft,
  cleanResult,
  cleanRoute,
  cleanRows,
  daysUntil,
  draftAsk,
  hideQuickTail,
  lineColor,
  multiAsk,
  multiLabel,
  shortDate,
  splitQuick,
} from './blocks.js'

describe('빠른 답', () => {
  it('답 끝 [[답: …]] 줄을 떼어 버튼 2~4개로', () => {
    const r = splitQuick(
      '다음 주 화요일 10시·목요일 3시가 비어 있어요. 어떻게 할까요?\n[[답: 화요일 10시로 | 목요일 3시로 | 다른 날 볼래]]',
    )
    expect(r.text).toBe('다음 주 화요일 10시·목요일 3시가 비어 있어요. 어떻게 할까요?')
    expect(r.replies).toEqual(['화요일 10시로', '목요일 3시로', '다른 날 볼래'])
  })
  it('하나뿐이거나 너무 긴 건 버튼 없이 줄만 지운다', () => {
    expect(splitQuick('어때요?\n[[답: 좋아요]]')).toEqual({ text: '어때요?' })
    const long = splitQuick(
      '골라 주세요\n[[답: 이건 스무 글자가 넘는 아주 아주 긴 빠른 답이에요 | 짧은 답 | 또 하나]]',
    )
    expect(long.replies).toEqual(['짧은 답', '또 하나'])
  })
  it('5개 넘으면 4개까지, 같은 건 하나로', () => {
    expect(splitQuick('?\n[[답: a | b | a | c | d | e]]').replies).toEqual(['a', 'b', 'c', 'd'])
  })
  it('글 가운데의 [[답: …]]은 건드리지 않는다', () => {
    const t = '예: [[답: a | b]] 이렇게 써요. 끝.'
    expect(splitQuick(t)).toEqual({ text: t })
  })
  it('흘러오는 중인 덜 온 꼬리는 감춘다', () => {
    expect(hideQuickTail('어떻게 할까요?\n[[답: 화요')).toBe('어떻게 할까요?')
    expect(hideQuickTail('어떻게 할까요?\n[[')).toBe('어떻게 할까요?')
    expect(hideQuickTail('어떻게 할까요?\n[[답: a | b]]')).toBe('어떻게 할까요?')
    expect(hideQuickTail('그냥 글이에요')).toBe('그냥 글이에요')
  })
})

describe('목록 줄', () => {
  it('제목 없는 줄은 빼고, https만, 날짜는 YYYY-MM-DD로', () => {
    const r = cleanRows({
      title: '공덕초',
      lead: 'date',
      rows: [
        { title: '겨울방학', date: '2027-1-7', url: 'http://school.example/a' },
        { sub: '제목 없음' },
        { title: '설 연휴', date: '아무 날', url: 'javascript:alert(1)' },
      ],
      action: { label: '캘린더에 넣기', ask: '이 일정 캘린더에 넣어 줘' },
    })
    expect(r?.rows).toEqual([
      { title: '겨울방학', date: '2027-01-07', url: 'https://school.example/a' },
      { title: '설 연휴' },
    ])
    expect(r?.lead).toBe('date')
    expect(r?.action).toEqual({ label: '캘린더에 넣기', ask: '이 일정 캘린더에 넣어 줘' })
  })
  it('줄이 하나도 없으면 블록을 만들지 않는다', () => {
    expect(cleanRows({ rows: [] })).toBeUndefined()
    expect(cleanRows({ rows: [{ sub: 'x' }] })).toBeUndefined()
  })
  it('날짜 앞머리인데 날짜가 없으면 앞머리 없이', () => {
    expect(cleanRows({ lead: 'date', rows: [{ title: 'a' }] })?.lead).toBe('none')
  })
  it('여러 개 고르기: 앞머리는 체크, 미리 고름(on:false만 끔), 버튼이 없으면 기본', () => {
    const r = cleanRows({
      pick: 'multi',
      lead: 'img',
      rows: [
        { title: '떡국떡', amount: 15960 },
        { title: '식혜', on: false, amount: 6900 },
      ],
    })
    expect(r?.lead).toBe('check')
    expect(r?.rows.map((x) => x.on)).toEqual([true, undefined])
    expect(r?.action?.label).toBe('고르기')
  })
  it('돈·삭제처럼 바로 일어나는 것 같은 버튼 이름은 버린다', () => {
    expect(cleanRows({ rows: [{ title: 'a' }], action: { label: '결제하기' } })?.action).toBeUndefined()
    expect(cleanRows({ rows: [{ title: 'a' }], action: { label: '전부 삭제' } })?.action).toBeUndefined()
  })
  it('글 대체본', () => {
    const r = cleanRows({
      title: '학교',
      lead: 'date',
      rows: [{ title: '방학', date: '2027-01-07', sub: '53일' }],
    })
    expect(r && blockText(r)).toBe('학교\n- 1/7(목) 방학 · 53일')
  })
})

describe('여러 개 고르기 버튼', () => {
  const rows = [
    { title: '떡국떡 1kg', amount: 15960 },
    { title: '한우 양지', amount: 12900 },
    { title: '식혜', amount: 6900 },
  ]
  it('개수와 합계(금액이 다 있을 때만)', () => {
    expect(multiLabel(rows, [true, true, false], '담기')).toBe('2개 담기 · 28,860원')
    expect(multiLabel([{ title: 'a' }, { title: 'b', amount: 1 }], [true, true], '담기')).toBe('2개 담기')
    expect(multiLabel(rows, [false, false, false], '담기')).toBe('고른 게 없어요')
  })
  it('보낼 말에 고른 것과 뺀 것', () => {
    expect(multiAsk(rows, [true, false, true], { label: '담기', ask: '고른 것만 담아 줘' })).toBe(
      '고른 것만 담아 줘: 떡국떡 1kg, 식혜 (뺀 것: 한우 양지)',
    )
  })
})

describe('결과 한 장', () => {
  it('큰 값이 없으면 만들지 않는다', () => {
    expect(cleanResult({ title: '예약' })).toBeUndefined()
  })
  it('정보 줄은 [이름, 값, "code"]도 받고, 단계는 2~6칸·지금 칸이 맞을 때만', () => {
    const r = cleanResult({
      title: '예약 확정',
      done: true,
      big: '11/21(토) 19:00',
      bigNote: '4명',
      facts: [['예약번호', 'CT-1', 'code'], { label: '가게', value: '소반' }, ['빈 값', '']],
      steps: { names: ['주문', '출고', '배송 중', '도착'], now: 2 },
      due: '2026-11-20',
      dueLabel: '취소 마감',
      actions: [
        { label: '예약 보기', url: 'https://x.example' },
        { label: '캘린더에 넣기' },
        { label: '세 번째' },
      ],
    })
    expect(r?.facts).toEqual([
      { label: '예약번호', value: 'CT-1', code: true },
      { label: '가게', value: '소반' },
    ])
    expect(r?.steps).toEqual({ names: ['주문', '출고', '배송 중', '도착'], now: 2 })
    expect(r?.actions).toEqual([
      { label: '예약 보기', url: 'https://x.example/' },
      { label: '캘린더에 넣기', ask: '캘린더에 넣기' },
    ])
    expect(cleanResult({ big: 'x', steps: { names: ['a', 'b'], now: 5 } })?.steps).toBeUndefined()
  })
})

describe('보낼 글', () => {
  it('글이 없으면 만들지 않고, 모르는 방법은 other', () => {
    expect(cleanDraft({ text: '  ' })).toBeUndefined()
    expect(cleanDraft({ text: '안녕하세요', via: 'fax' })).toEqual({
      kind: 'draft',
      via: 'other',
      text: '안녕하세요',
    })
  })
  it('[보내기]는 두리에게 부탁하는 말', () => {
    expect(draftAsk({ kind: 'draft', via: 'sms', to: '집주인', text: 'x' })).toBe(
      '방금 쓴 글 그대로 집주인에게 문자로 보내 줘',
    )
    expect(draftAsk({ kind: 'draft', via: 'post', text: 'x' })).toBe('방금 쓴 글 그대로 올려 줘')
  })
})

describe('날짜', () => {
  it('짧은 날짜와 남은 날 (한국 시간)', () => {
    expect(shortDate('2027-01-07')).toBe('1/7(목)')
    // 2026-11-19 23:30 한국 시간 = 14:30 UTC
    const now = Date.parse('2026-11-19T14:30:00Z')
    expect(daysUntil('2026-11-19', now)).toBe(0)
    expect(daysUntil('2026-11-25', now)).toBe(6)
    expect(daysUntil('2026-11-18', now)).toBe(-1)
    // 한국은 벌써 20일
    expect(daysUntil('2026-11-20', Date.parse('2026-11-19T15:30:00Z'))).toBe(0)
  })
})

describe('경로 카드', () => {
  const ask = {
    title: '강남역 → 대화역',
    from: '카카오맵',
    big: '23:25까지 강남역 출발',
    bigNote: '1시간 16분 · 환승 1 · 2,150원',
    legs: [
      { line: '2호선', from: '강남역', to: '교대역', minutes: 2, last: '00:46:30' },
      {
        mode: 'subway',
        line: '3호선',
        from: '교대역',
        to: '대화역',
        minutes: 72,
        last: '23:29',
        note: '대화 방면',
      },
      { line: '', from: 'x', to: 'y' },
    ],
    facts: [{ label: '놓치면', value: '합정에서 광역 M7731 (강남 00:21까지)' }],
    actions: [{ label: '카카오맵에서 보기', url: 'https://map.kakao.com/?target=traffic' }],
  }
  it('구간을 다듬고 노선 이름으로 탈것을 짐작한다', () => {
    const r = cleanRoute(ask)
    expect(r?.legs).toHaveLength(2)
    expect(r?.legs[0]).toEqual({
      mode: 'subway',
      line: '2호선',
      from: '강남역',
      to: '교대역',
      minutes: 2,
      last: '00:46',
    })
    expect(r?.legs[1]?.note).toBe('대화 방면')
    expect(
      cleanRoute({ big: '1시간', legs: [{ line: '광역 M7731', from: '합정역', to: '대화역' }] })?.legs[0]
        ?.mode,
    ).toBe('bus')
    expect(cleanRoute({ big: '', legs: ask.legs })).toBeUndefined()
    expect(cleanRoute({ big: '1시간', legs: [] })).toBeUndefined()
  })
  it('노선 색: 지하철은 공식 색, 버스는 종류 색', () => {
    expect(lineColor({ mode: 'subway', line: '2호선' })).toBe('#00A84D')
    expect(lineColor({ mode: 'subway', line: '3호선' })).toBe('#EF7C1C')
    expect(lineColor({ mode: 'subway', line: '신분당선' })).toBe('#D4003B')
    expect(lineColor({ mode: 'bus', line: '광역 M7731' })).toBe('#E60012')
    expect(lineColor({ mode: 'bus', line: '간선 440' })).toBe('#3D5BAB')
  })
  it('글 대체본에 결론·구간·막차가 남는다', () => {
    const r = cleanRoute(ask)
    if (!r) throw new Error('없음')
    const t = blockText(r)
    expect(t).toContain('23:25까지 강남역 출발')
    expect(t).toContain('3호선 교대역 → 대화역 · 72분 · 막차 23:29')
    expect(t).toContain('놓치면: 합정에서 광역 M7731')
  })
})
