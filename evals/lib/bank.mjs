// 시험 은행: 시나리오 가족(bank/families/*.jsonl) × 말투 × 값 × 교란(bank/perturb.json) → 시나리오 목록.
// 가족 한 줄 형식은 evals/README.md. 펼치는 규칙은 처음 만든 도구(expand.py)와 같다 (같은 id가 나와야 기록을 이어 볼 수 있다)
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EVALS = join(dirname(fileURLToPath(import.meta.url)), '..')
export const ROOT = join(EVALS, '..')
const BANK = join(EVALS, 'bank')

const json = (p) => JSON.parse(readFileSync(p, 'utf8'))

/** 가족 전부 (파일 이름 순) */
export function families() {
  const out = []
  for (const f of readdirSync(join(BANK, 'families')).sort()) {
    if (!f.endsWith('.jsonl')) continue
    readFileSync(join(BANK, 'families', f), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const t = line.trim()
        if (!t || t.startsWith('//')) return
        try {
          out.push({ ...JSON.parse(t), file: f })
        } catch (e) {
          throw new Error(`${f}:${i + 1} ${e.message}`)
        }
      })
  }
  return out
}

export const perturbs = () => json(join(BANK, 'perturb.json'))
export const gaps = () => json(join(BANK, 'gaps.json'))

const SLOT = /\{(\w+)\}/g
const fill = (s, vals) => (s ?? '').replace(SLOT, (m, k) => (k in vals ? String(vals[k]) : m))
/** Fills the slots in every string of a value (a scenario's seed) */
const fillDeep = (v, vals) =>
  typeof v === 'string'
    ? fill(v, vals)
    : Array.isArray(v)
      ? v.map((x) => fillDeep(x, vals))
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, vals)]))
        : v

/** 슬롯마다 같은 순번 값을 묶고(i번째끼리), 짧은 목록은 돌려 쓴다 */
function combos(slots, n) {
  const keys = Object.keys(slots ?? {})
  if (!keys.length) return Array.from({ length: n }, () => ({}))
  const width = Math.max(...keys.map((k) => slots[k].length))
  return Array.from({ length: Math.max(n, width) }, (_, i) =>
    Object.fromEntries(keys.map((k) => [k, slots[k][i % slots[k].length]])),
  )
}

/** 시나리오 전부. 각 시나리오에 고른 값(slots)도 붙인다 (도구 이름의 <svc>를 풀 때 쓴다) */
export function scenarios() {
  const P = perturbs()
  const out = []
  const seen = new Set()
  for (const fam of families()) {
    const asks = fam.asks ?? []
    const cs = combos(fam.slots, asks.length)
    let k = 0
    const bases = []
    cs.forEach((c, i) => {
      const ask = fill(asks[i % asks.length], c)
      if (seen.has(ask)) return
      seen.add(ask)
      k += 1
      const sc = {
        id: `${fam.fid}#${k}`,
        fid: fam.fid,
        cat: fam.cat,
        title: fam.title ?? '',
        type: fam.type ?? '',
        ask,
        ctx: fill(fam.ctx, c),
        // What is put in place before the request (a running task, evals/run.mjs --main on)
        ...(fam.seed ? { seed: fillDeep(fam.seed, c) } : {}),
        expect: fill(fam.expect, c),
        never: fill(fam.never, c),
        appr: fam.appr ?? '',
        human: fam.human ?? '',
        tools: fam.tools ?? '',
        now: fam.now ?? 'part',
        gaps: fam.gaps ?? [],
        perturb: '',
        pri: fam.pri ?? 2,
        slots: c,
      }
      out.push(sc)
      bases.push([sc, c])
    })
    let pert = fam.perturb ?? {}
    if (Array.isArray(pert)) pert = Object.fromEntries(pert.map((p) => [p, '']))
    Object.entries(pert).forEach(([key, extra], j) => {
      if (!P[key] || !bases.length) return
      const p = P[key]
      const [b, c] = bases[j % bases.length]
      let ask = b.ask
      const bctx = key === '연결안됨' ? b.ctx.replaceAll('연결됨', '연결 안 됨') : b.ctx
      if (key === '모호' && fam.vague?.length) ask = fill(fam.vague[j % fam.vague.length], c)
      k += 1
      out.push({
        ...b,
        id: `${fam.fid}#${k}`,
        ask,
        type: p.type,
        perturb: key,
        ctx: (bctx ? `${bctx} / ` : '') + p.ctx + (extra ? ` (${fill(extra, c)})` : ''),
        expect: `${p.expect} · 원래 목표: ${b.expect}`,
        never: p.never + (b.never ? ` · ${b.never}` : ''),
      })
    })
  }
  return out
}

const norm = (x) =>
  String(x ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[\s.·+_-]|닷컴|항공|\.com/g, '')

/** 레포의 서비스 연결 카드: 이름·id → id. get(v)는 정확히 같은 이름이 없으면 비슷한 이름(띄어쓰기·괄호·'항공' 무시, 앞부분 포함)으로 찾는다 */
export function serviceIds() {
  const cards = []
  for (const id of readdirSync(join(ROOT, 'skills'))) {
    try {
      const c = json(join(ROOT, 'skills', id, 'connect.json'))
      cards.push({ id: c.id, keys: [norm(c.name), norm(c.id)].filter(Boolean) })
    } catch {}
  }
  // 카드 이름이 영어인 곳의 한글 이름
  const KO = {
    부킹: 'booking',
    에어비앤비: 'airbnb',
    예스24: 'yes24',
    아고다: 'agoda',
    우버: 'uber',
    클룩: 'klook',
  }
  return {
    get(v) {
      const n = norm(v)
      if (KO[n]) return KO[n]
      if (!n) return undefined
      const exact = cards.find((c) => c.keys.includes(n))
      if (exact) return exact.id
      // 'CGV 용산아이파크몰' → cgv, 'LG U+' → lguplus는 못 찾는다(그대로 빈틈으로 남긴다)
      return cards.find((c) => c.keys.some((k) => k.length >= 2 && (n.startsWith(k) || k.startsWith(n))))?.id
    },
  }
}

// 두리는 AI의 기본 도구(셸·파일·웹)를 모두 끄고 두리 도구만 쓴다 (agent-claude --tools '').
// 웹 검색은 브라우저로 검색 사이트를 열어 하니 있는 것으로 본다. 파일은 두리 도구 file_find·file_read·file_write(ADR 0022)
const BUILTIN = ['web_search', 'web_fetch']

/** 지금 AI가 쓸 수 있는 도구 이름 전부: 서비스 도구(skills/<id>/tools.json) + 두리 MCP 도구(목록 시험에 적힌 이름) + 기본 도구 */
export function toolNames() {
  const names = new Set(BUILTIN)
  for (const id of readdirSync(join(ROOT, 'skills'))) {
    try {
      const d = json(join(ROOT, 'skills', id, 'tools.json'))
      for (const t of d.tools ?? []) names.add(`${d.id.replace(/-/g, '_')}_${t.name}`)
    } catch {}
  }
  // 두리 MCP 도구 이름은 목록 시험(tools.test.ts)이 전부 적어 둔다 (browser_·screen_는 만들 때 앞말을 붙여서 소스에 그대로 없다)
  const listed = readFileSync(join(ROOT, 'packages', 'mcp-tools', 'src', 'tools.test.ts'), 'utf8')
  for (const m of listed.matchAll(/'([a-z]+_[a-z0-9_]+)'/g)) names.add(m[1])
  // 은행에서 앞말 없이 적은 것 (request_approval = browser_·screen_request_approval)
  for (const n of [...names]) {
    const m = /^(?:browser|screen)_(.+)$/.exec(n)
    if (m) names.add(m[1])
  }
  return names
}

/**
 * 시나리오의 tools 칸("<svc>_prepare_order → <svc>_orders (… 브라우저)")에서 도구 이름을 뽑는다.
 * <svc>·<슬롯>은 그 시나리오 값으로 풀고(쿠팡 → coupang_prepare_order), 서비스 카드가 없으면 missing에 남긴다
 */
export function neededTools(sc, ids = serviceIds()) {
  const out = []
  const noService = []
  for (const m of (sc.tools ?? '').matchAll(/(?:<(\w+)>|\b([a-z][a-z0-9-]*))_([a-z][a-z0-9_]*)\b/g)) {
    const [, slot, plain, rest] = m
    if (slot) {
      const v = sc.slots?.[slot]
      const id = v && ids.get(v)
      if (!id) {
        noService.push(v ?? `<${slot}>`)
        continue
      }
      out.push(`${id.replace(/-/g, '_')}_${rest}`)
    } else out.push(`${plain.replace(/-/g, '_')}_${rest}`)
  }
  // 글로 적은 파일 일: "파일 쓰기(엑셀)", "파일 읽기(PDF)", "PC 파일"
  const t = sc.tools ?? ''
  if (/파일\s*(?:읽기|확인|찾기)|PC 파일|파일 → |다운로드 → 파일/.test(t)) out.push('file_read')
  if (/파일\s*(?:쓰기|저장|만들기)|엑셀\s*(?:만들기|쓰기)/.test(t)) out.push('file_write')
  return { tools: [...new Set(out)], noService: [...new Set(noService)] }
}
