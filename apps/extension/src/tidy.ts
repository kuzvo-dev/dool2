// 두리 탭 정리: 다 쓴 탭이 쌓이면 Chrome이 몇 GB씩 메모리를 먹는다.
// AI가 일 끝에 탭을 닫는 걸 잊어도, 확장이 알아서 오래 안 쓴 두리 탭을 잠재우고(discard) 닫는다.
// 판단만 하는 순수 함수라 테스트로 고정한다 (실제 닫기·잠재우기는 background.ts).

/** 두리 탭은 이만큼만 열어 둔다. 새로 열면 가장 오래 안 쓴 탭부터 닫는다.
 * 지도·목록이 무거운 사이트는 탭 하나가 0.5~1GB라 8GB 맥에서 4개도 버겁다(실측: 캐치테이블 검색 지도) */
export const MAX_TABS = 3
/** 이만큼 안 쓰면 잠재운다 (탭은 남고 메모리만 비운다. 다시 쓰면 새로 불러온다). 승인 기다림(10분)보다 길게 */
export const SLEEP_AFTER_MS = 12 * 60_000
/** 방금 열었거나 쓴 탭: 너무 많아도 이 동안은 닫지 않는다 */
export const RECENT_MS = 60_000
/** 이만큼 안 쓰면 닫는다 */
export const CLOSE_AFTER_MS = 45 * 60_000

export interface TidyTab {
  id: number
  /** 두리가 마지막으로 이 탭에 무언가를 시킨 때 (모르면 지금으로 본다) */
  usedAt: number
  /** 폰에서 원격 화면으로 보고 있거나, 방금 연 탭, 잡아 둔(hold) 탭: 건드리지 않는다 */
  keep?: boolean
  /**
   * 가족 탭: 연 새 창이 아직 살아 있는 탭(결제 창을 띄운 주문서)이거나, 살아 있는 탭이 30분 안에 연 탭(결제 창).
   * 닫지도 재우지도 않는다 — 주문서를 닫거나 재우면 결제 창이 결과를 돌려줄 곳이 없어 결제가 끊긴다 (실측 11-20 G마켓)
   */
  family?: boolean
  /** 이미 잠들어 있음 */
  discarded?: boolean
  /** 창에서 앞에 나와 있는 탭은 Chrome이 잠재우지 못한다 */
  active?: boolean
}

export interface TidyPlan {
  close: number[]
  sleep: number[]
}

export function tidyPlan(input: TidyTab[], now: number, max = MAX_TABS): TidyPlan {
  const tabs = input.map((t) => (t.family ? { ...t, keep: true } : t))
  const close = new Set<number>()
  // 1) 오래 안 쓴 탭은 닫는다
  for (const t of tabs) if (!t.keep && now - t.usedAt >= CLOSE_AFTER_MS) close.add(t.id)
  // 2) 그래도 많으면 가장 오래 안 쓴 것부터 닫는다. 방금(1분 안) 열었거나 쓴 탭은 닫지 않는다:
  //    로그인 버튼이 연 카카오·네이버 창(넘겨받은 탭)이 열리자마자 닫혀 '탭이 닫혔어요'로 멈췄다 (실측 2026-11-19)
  const left = tabs.filter((t) => !close.has(t.id))
  const extra = left.length - max
  if (extra > 0) {
    const oldest = left
      .filter((t) => !t.keep && now - t.usedAt >= RECENT_MS)
      .sort((a, b) => a.usedAt - b.usedAt)
    for (const t of oldest.slice(0, extra)) close.add(t.id)
  }
  // 3) 남은 것 중 한동안 안 쓴 탭은 잠재운다
  const sleep = tabs
    .filter(
      (t) => !close.has(t.id) && !t.keep && !t.discarded && !t.active && now - t.usedAt >= SLEEP_AFTER_MS,
    )
    .map((t) => t.id)
  return { close: [...close], sleep }
}
