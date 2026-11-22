// 문서 디자인 틀 (file_write의 look): 두리가 HTML 보고서·안내문·편지·표를 매번 처음부터 꾸미면 평범하고 빈 곳이 많았다(11-22 지적).
// 디자인은 여기서 정해 두고, 두리는 내용과 정해진 이름표(class)만 쓴다. 그리는 창은 바깥 주소를 막으니 글꼴·차트도 모두 이 안에서.

export const DOC_LOOKS = ['report', 'notice', 'letter', 'sheet'] as const
export type DocLook = (typeof DOC_LOOKS)[number]

const BASE = `
:root{--ink:#14181f;--sub:#5b6472;--line:#e4e7ec;--soft:#f5f7fa;--accent:#0f766e;--accent-2:#14b8a6;--warn:#b45309;--warn-bg:#fff7ed;--good:#047857;--bad:#b91c1c}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;color:var(--ink);background:#fff;font:15px/1.65 "Pretendard","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;word-break:keep-all;overflow-wrap:break-word}
.page{max-width:794px;margin:0 auto;padding:44px 52px 40px}
h1{font-size:28px;line-height:1.3;margin:0 0 8px;letter-spacing:-.02em}
h2{font-size:19px;margin:30px 0 12px;padding-bottom:8px;border-bottom:2px solid var(--ink);letter-spacing:-.01em;break-after:avoid}
h3{font-size:16px;margin:20px 0 8px;break-after:avoid}
p{margin:0 0 10px}
ul,ol{margin:0 0 12px;padding-left:20px}
li{margin:3px 0}
strong{font-weight:700}
.muted,.sub{color:var(--sub)}
.small{font-size:13px}
.eyebrow{font-size:12px;font-weight:700;letter-spacing:.08em;color:var(--accent);text-transform:uppercase;margin-bottom:6px}
.lead{font-size:16px;color:var(--sub);margin-bottom:0}
.cover{background:linear-gradient(135deg,#0f3d3a,#0f766e);color:#fff;border-radius:18px;padding:30px 32px;margin-bottom:22px}
.cover h1{color:#fff;font-size:30px}
.cover .lead,.cover .eyebrow{color:rgba(255,255,255,.82)}
.cover .meta{margin-top:14px;font-size:13px;color:rgba(255,255,255,.75)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0 18px;break-inside:avoid}
.kpi{background:var(--soft);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.kpi b{display:block;font-size:24px;letter-spacing:-.02em;color:var(--accent)}
.kpi span{display:block;font-size:13px;color:var(--sub);margin-top:2px}
.kpi.up b{color:var(--good)}.kpi.down b{color:var(--bad)}
.callout{border-left:4px solid var(--accent);background:#effaf8;border-radius:0 12px 12px 0;padding:12px 16px;margin:14px 0;break-inside:avoid}
.callout.warn{border-color:var(--warn);background:var(--warn-bg)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px;break-inside:avoid}
table{width:100%;border-collapse:collapse;margin:10px 0 16px;font-size:14px;break-inside:auto}
thead{display:table-header-group}
tr{break-inside:avoid}
th{background:var(--soft);text-align:left;font-weight:700;padding:9px 10px;border-bottom:2px solid var(--line)}
td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tr.total td{font-weight:700;border-top:2px solid var(--ink)}
.tag{display:inline-block;font-size:12px;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--soft);color:var(--sub)}
.tag.good{background:#ecfdf5;color:var(--good)}.tag.bad{background:#fef2f2;color:var(--bad)}.tag.warn{background:var(--warn-bg);color:var(--warn)}
.bars{margin:10px 0 18px;break-inside:avoid}
.bar{display:grid;grid-template-columns:120px 1fr 70px;align-items:center;gap:10px;margin:7px 0;font-size:14px}
.bar i{display:block;height:14px;border-radius:7px;background:linear-gradient(90deg,var(--accent),var(--accent-2));width:var(--v,0%)}
.bar em{font-style:normal;text-align:right;font-variant-numeric:tabular-nums;color:var(--sub)}
.steps{counter-reset:s;list-style:none;padding:0}
.steps li{counter-increment:s;position:relative;padding-left:36px;margin:10px 0}
.steps li::before{content:counter(s);position:absolute;left:0;top:0;width:24px;height:24px;border-radius:50%;background:var(--accent);color:#fff;font-size:13px;font-weight:700;display:grid;place-items:center}
.sources{margin-top:26px;font-size:12px;color:var(--sub);border-top:1px solid var(--line);padding-top:10px}
.sources a{color:var(--sub)}
.foot{margin-top:28px;font-size:12px;color:var(--sub);text-align:right}
.pagebreak{break-before:page}
@page{size:A4;margin:14mm 12mm}
@media print{.page{padding:0;max-width:none}}
`

const LOOK: Record<DocLook, string> = {
  report: '',
  notice: `
/* 붙여 두는 안내문: 멀리서도 읽히게 크게, A4 한 쪽을 채운다 */
body{font-size:19px;line-height:1.75}
.page{min-height:258mm;display:flex;flex-direction:column;padding-top:40px}
@media print{.page{min-height:258mm}}
h1{text-align:center;font-size:38px}
.cover{padding:40px 36px;text-align:center}
.cover h1{font-size:40px}
.lead{text-align:center;font-size:19px}
.box{border:3px solid var(--ink);border-radius:18px;padding:26px 30px;margin:26px 0}
.box dl{display:grid;grid-template-columns:120px 1fr;gap:14px 18px;margin:0;font-size:22px}
.box dt{font-weight:700;color:var(--sub)}
.box dd{margin:0;font-weight:700}
.callout{font-size:19px}
.sign{text-align:right;margin-top:auto;padding-top:34px;font-size:21px;font-weight:700}
`,
  letter: `
.page{padding:64px 64px 48px}
body{font-size:16px;line-height:1.85}
h1{font-size:24px;margin-bottom:24px}
.to{font-size:17px;font-weight:700;margin-bottom:18px}
.from{text-align:right;margin-top:36px}
.date{text-align:right;color:var(--sub);margin-top:6px}
`,
  sheet: `
.page{max-width:1123px;padding:28px 28px}
table{font-size:13px}
th,td{padding:6px 8px}
`,
}

/** 두리가 쓴 HTML에 디자인 틀을 넣는다: <head>가 있으면 그 안에, 없으면 문서로 감싼다. 내용은 .page 안에 */
export function applyLook(html: string, look: DocLook): string {
  const css = `<style data-dool2-look="${look}">${BASE}${LOOK[look]}</style>`
  const meta = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${css}`)
  const body = /<body[^>]*>/i.test(html) ? html : `<body><main class="page">${html}</main></body>`
  return `<!doctype html><html lang="ko"><head>${meta}${css}</head>${body.replace(/^[\s\S]*?(<body)/i, '$1')}</html>`
}

/** 도구 설명에 붙는 이름표 안내 (짧게) */
export const LOOK_GUIDE =
  'look을 주면 다듬은 디자인 틀을 본체가 넣어 준다(스타일을 직접 쓰지 말고 내용과 이름표만): ' +
  'report=보고서·조사·비교, notice=안내문·공지·신청서, letter=편지·사과문·추천서, sheet=넓은 표. ' +
  '이름표: <div class="cover"><div class="eyebrow">분류</div><h1>제목</h1><p class="lead">한 줄 요약</p><div class="meta">날짜·작성</div></div>, ' +
  '<div class="kpis"><div class="kpi up"><b>119만</b><span>설명</span></div></div>(핵심 숫자 3~4개), <div class="callout">핵심 한마디</div>(warn이면 주의), ' +
  '<div class="bars"><div class="bar"><span>이름</span><i style="--v:62%"></i><em>62%</em></div></div>(막대그래프), 표 숫자 칸은 class="num", 합계 줄은 tr class="total", ' +
  '<span class="tag good|bad|warn">, <ol class="steps">(순서), <div class="two">(두 칸), <div class="sources">(출처), 쪽 나눔은 <div class="pagebreak"></div>. ' +
  'notice는 <div class="box"><dl><dt>일시</dt><dd>…</dd></dl></div>와 <p class="sign">, letter는 <p class="to">·<p class="from">·<p class="date">. 내용은 <main class="page"> 안에 쓴다(없으면 본체가 감싼다).'
