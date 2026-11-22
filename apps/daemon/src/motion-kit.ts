// 모션 키트 (video_motion): 두리가 장면(scene)과 이름표(class)만 쓰면 움직임은 여기서 정한다.
// PC 앱이 보이지 않는 창에서 시간을 한 장씩 맞춰(document.getAnimations의 currentTime) 찍으므로
// 움직임은 모두 CSS 애니메이션이어야 한다. 아래 스크립트는 열 때 한 번만 돌아 장면 시각·글자 나누기·색종이를 만든다
// (11-23 사용자: "모션그래픽 너무 단조롭다" → 레퍼런스: 키네틱 타이포·색종이·폴라로이드 콜라주·질감·레이어 깊이).

export const MOTION_SHAPES = {
  portrait: [1080, 1920],
  landscape: [1920, 1080],
  square: [1080, 1080],
} as const
export type MotionShape = keyof typeof MOTION_SHAPES

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:var(--w);height:var(--h);overflow:hidden;background:#000}
body{font-family:"Pretendard","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;color:#fff;word-break:keep-all}
.scene{position:absolute;inset:0;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:calc(var(--h)*.02);padding:calc(var(--w)*.08);text-align:center;opacity:0}
/* 장면 들어오고 나가기 (스크립트가 시각을 넣는다) */
.scene{animation:var(--in,s-fade) .6s cubic-bezier(.2,.8,.2,1) var(--s) both, s-out .45s ease-in var(--e) forwards}
@keyframes s-fade{from{opacity:0}to{opacity:1}}
@keyframes s-zoom{from{opacity:0;transform:scale(1.25)}to{opacity:1;transform:none}}
@keyframes s-slide{0%{opacity:0}1%{opacity:1;transform:translateY(100%)}100%{opacity:1;transform:none}}
@keyframes s-wipe{0%{opacity:0}1%{opacity:1;clip-path:inset(0 100% 0 0)}100%{opacity:1;clip-path:inset(0 0 0 0)}}
@keyframes s-circle{0%{opacity:0}1%{opacity:1;clip-path:circle(0% at 50% 50%)}100%{opacity:1;clip-path:circle(75% at 50% 50%)}}
@keyframes s-flash{0%{opacity:0}1%{opacity:1;filter:brightness(4)}100%{opacity:1;filter:none}}
@keyframes s-out{to{opacity:0}}
.scene.last{animation:var(--in,s-fade) .6s cubic-bezier(.2,.8,.2,1) var(--s) both}
/* 글자 크기 */
.huge{font-size:calc(var(--w)*.15);font-weight:900;line-height:1.05;letter-spacing:-.03em}
.big{font-size:calc(var(--w)*.10);font-weight:800;line-height:1.15;letter-spacing:-.02em}
.mid{font-size:calc(var(--w)*.065);font-weight:700;line-height:1.3}
.small{font-size:calc(var(--w)*.042);font-weight:600;line-height:1.45;opacity:.9}
.shadow{text-shadow:0 6px 30px rgba(0,0,0,.45)}
.outline{-webkit-text-stroke:calc(var(--w)*.006) currentColor;color:transparent}
.pill{display:inline-block;padding:.25em .7em;border-radius:999px;background:var(--accent,#ff5a8a);color:#fff}
.box{padding:.4em .7em;border-radius:.4em;background:rgba(0,0,0,.45)}
.top{position:absolute;top:8%;left:0;right:0}.bottom{position:absolute;bottom:9%;left:0;right:0}
/* 들어오는 움직임 (style="--at:.4s"로 장면 안 시각) */
.pop,.rise,.drop,.slam,.zoom,.left,.right,.spin,.stamp,.type,.reveal,.blur,.polaroid,.words>span,.marker::after{animation-fill-mode:both;animation-timing-function:cubic-bezier(.2,.9,.25,1.2)}
.pop{animation-name:k-pop;animation-duration:.55s}
@keyframes k-pop{0%{opacity:0;transform:scale(.2)}70%{opacity:1;transform:scale(1.12)}100%{transform:scale(1)}}
.rise{animation-name:k-rise;animation-duration:.7s;animation-timing-function:cubic-bezier(.2,.8,.2,1)}
@keyframes k-rise{from{opacity:0;transform:translateY(40%)}to{opacity:1;transform:none}}
.drop{animation-name:k-drop;animation-duration:.8s}
@keyframes k-drop{0%{opacity:0;transform:translateY(-120%)}60%{opacity:1;transform:translateY(6%)}80%{transform:translateY(-3%)}100%{transform:none}}
.slam{animation-name:k-slam;animation-duration:.45s;animation-timing-function:cubic-bezier(.3,1.4,.4,1)}
@keyframes k-slam{0%{opacity:0;transform:scale(3);filter:blur(10px)}100%{opacity:1;transform:scale(1);filter:none}}
.zoom{animation-name:k-zoom;animation-duration:.8s;animation-timing-function:ease-out}
@keyframes k-zoom{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
.left{animation-name:k-left;animation-duration:.7s}.right{animation-name:k-right;animation-duration:.7s}
@keyframes k-left{from{opacity:0;transform:translateX(-60%)}to{opacity:1;transform:none}}
@keyframes k-right{from{opacity:0;transform:translateX(60%)}to{opacity:1;transform:none}}
.spin{animation-name:k-spin;animation-duration:.8s}
@keyframes k-spin{from{opacity:0;transform:rotate(-200deg) scale(.3)}to{opacity:1;transform:none}}
.stamp{animation-name:k-stamp;animation-duration:.5s}
@keyframes k-stamp{0%{opacity:0;transform:rotate(-12deg) scale(2.4)}70%{opacity:1;transform:rotate(-8deg) scale(.95)}100%{opacity:1;transform:rotate(-8deg) scale(1)}}
.type{display:inline-block;overflow:hidden;white-space:nowrap;border-right:.06em solid currentColor;animation-name:k-type;animation-duration:var(--type,1.2s);animation-timing-function:steps(var(--n,12))}
@keyframes k-type{from{max-width:0}to{max-width:100%}}
.reveal{animation-name:k-reveal;animation-duration:.8s;animation-timing-function:cubic-bezier(.7,0,.2,1)}
@keyframes k-reveal{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
.blur{animation-name:k-blur;animation-duration:.9s;animation-timing-function:ease-out}
@keyframes k-blur{from{opacity:0;filter:blur(24px);letter-spacing:.3em}to{opacity:1;filter:none}}
/* 낱말마다 차례로 (키네틱 타이포): <h1 class="words big">생일 축하해 하늘아</h1> */
.words>span{display:inline-block;animation-name:k-word;animation-duration:.5s;margin:0 .12em}
@keyframes k-word{0%{opacity:0;transform:translateY(60%) rotate(6deg)}100%{opacity:1;transform:none}}
/* 형광펜 밑줄 */
.marker{position:relative;display:inline-block;z-index:0}
.marker::after{content:"";position:absolute;left:-.1em;right:-.1em;bottom:.08em;height:.38em;background:var(--accent,#ffd84d);z-index:-1;transform-origin:left;animation-name:k-mark;animation-duration:.6s}
@keyframes k-mark{from{transform:scaleX(0)}to{transform:scaleX(1)}}
/* 계속 움직이는 것 (장면 내내) */
.float{animation:k-float 3s ease-in-out infinite alternate}
@keyframes k-float{from{transform:translateY(-3%)}to{transform:translateY(3%)}}
.pulse{animation:k-pulse 1.2s ease-in-out infinite alternate}
@keyframes k-pulse{from{transform:scale(1)}to{transform:scale(1.06)}}
.wiggle{animation:k-wig .5s ease-in-out infinite alternate}
@keyframes k-wig{from{transform:rotate(-3deg)}to{transform:rotate(3deg)}}
/* 사진 */
.bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-2}
video{object-fit:cover}
.kenburns{animation:k-kb var(--d,4s) ease-out both}
@keyframes k-kb{from{transform:scale(1.18) translate(2%,1%)}to{transform:scale(1) translate(0,0)}}
.pan{animation:k-pan var(--d,4s) linear both}
@keyframes k-pan{from{transform:scale(1.2) translateX(6%)}to{transform:scale(1.2) translateX(-6%)}}
.dim::before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.35),rgba(0,0,0,.05) 40%,rgba(0,0,0,.55));z-index:-1}
.photo{max-width:78%;max-height:58%;border-radius:calc(var(--w)*.03);box-shadow:0 30px 80px rgba(0,0,0,.45);object-fit:cover}
.polaroid{background:#fff;padding:calc(var(--w)*.025) calc(var(--w)*.025) calc(var(--w)*.09);box-shadow:0 30px 70px rgba(0,0,0,.4);transform:rotate(var(--r,-4deg));animation-name:k-pola;animation-duration:.9s;color:#333;font-weight:700;font-size:calc(var(--w)*.045)}
.polaroid img{display:block;width:calc(var(--w)*.62);height:calc(var(--w)*.62);object-fit:cover}
@keyframes k-pola{0%{opacity:0;transform:translateY(-60%) rotate(calc(var(--r,-4deg) - 20deg)) scale(1.1)}70%{opacity:1;transform:translateY(3%) rotate(var(--r,-4deg))}100%{transform:rotate(var(--r,-4deg))}}
.collage{position:relative;width:100%;height:62%}
.collage .polaroid{position:absolute}
/* 배경 */
.grad::before{content:"";position:absolute;inset:0;z-index:-3;background:linear-gradient(135deg,var(--c1,#ff8fb1),var(--c2,#7cc8ff),var(--c3,#ffe27a));background-size:300% 300%;animation:k-grad var(--d,6s) ease-in-out var(--s,0s) both}
@keyframes k-grad{from{background-position:0% 50%}to{background-position:100% 50%}}
.paper{background:#f6efe3 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3'/%3E%3CfeColorMatrix values='0 0 0 0 .4 0 0 0 0 .35 0 0 0 0 .3 0 0 0 .09 0'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)'/%3E%3C/svg%3E");color:#2b2622}
.grain::after{content:"";position:absolute;inset:-50%;z-index:4;pointer-events:none;opacity:.16;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");animation:k-grain .5s steps(4) infinite}
@keyframes k-grain{0%{transform:translate(0,0)}25%{transform:translate(-3%,2%)}50%{transform:translate(2%,-3%)}75%{transform:translate(-2%,-1%)}}
.letterbox::before,.letterbox::after{content:"";position:absolute;left:0;right:0;height:9%;background:#000;z-index:5;animation:k-lb .8s ease-out var(--s,0s) both}
.letterbox::before{top:0}.letterbox::after{bottom:0}
@keyframes k-lb{from{height:0}to{height:9%}}
/* 장식 */
.particles{position:absolute;inset:0;pointer-events:none;z-index:3}
.particles i{position:absolute;top:-6%;display:block;animation:k-fall var(--fd) linear var(--fdel) both}
@keyframes k-fall{from{transform:translate(0,0) rotate(0)}to{transform:translate(var(--dx),118vh) rotate(var(--rot))}}
.particles.up i{top:auto;bottom:-8%;animation-name:k-rise-p}
@keyframes k-rise-p{from{transform:translate(0,0)}to{transform:translate(var(--dx),-118vh)}}
.burst{position:absolute;inset:0;pointer-events:none;z-index:3}
.burst i{position:absolute;left:50%;top:50%;animation:k-burst .9s cubic-bezier(.1,.8,.3,1) var(--fdel) both}
@keyframes k-burst{from{transform:translate(-50%,-50%) scale(.2);opacity:1}to{transform:translate(calc(-50% + var(--bx)),calc(-50% + var(--by))) scale(1) rotate(var(--rot));opacity:0}}
.line{position:absolute;inset:0;pointer-events:none}
.line path{fill:none;stroke:var(--accent,#fff);stroke-width:8;stroke-linecap:round;stroke-dasharray:3000;stroke-dashoffset:3000;animation:k-draw 1.6s ease-in-out var(--fdel,0s) forwards}
@keyframes k-draw{to{stroke-dashoffset:0}}
.progress{position:absolute;left:0;bottom:0;height:.6%;background:var(--accent,#fff);animation:k-prog var(--total) linear both;transform-origin:left;width:100%}
@keyframes k-prog{from{transform:scaleX(0)}to{transform:scaleX(1)}}
`

const JS = `
(function(){
  var seed=7;function rnd(){seed=(seed*16807)%2147483647;return seed/2147483647}
  var scenes=[].slice.call(document.querySelectorAll('.scene'));var t=0;
  scenes.forEach(function(s,i){
    var start=s.dataset.start!=null?parseFloat(s.dataset.start):t;var dur=parseFloat(s.dataset.dur||'3');
    var end=start+dur;t=end;
    s.style.setProperty('--s',start+'s');s.style.setProperty('--e',(end-0.45)+'s');s.style.setProperty('--d',dur+'s');
    if(s.dataset.in)s.style.setProperty('--in','s-'+s.dataset.in);
    [].slice.call(s.querySelectorAll('video')).forEach(function(v){v.muted=true;v.dataset.sceneStart=String(start);v.preload='auto'});
    if(i===scenes.length-1)s.classList.add('last');
    s.style.zIndex=10+i;
    // 낱말 나누기
    [].slice.call(s.querySelectorAll('.words')).forEach(function(el){
      var ws=el.textContent.trim().split(/\\s+/);el.textContent='';
      ws.forEach(function(w,k){var sp=document.createElement('span');sp.textContent=w;sp.style.setProperty('--at',(parseFloat(getComputedStyle(el).getPropertyValue('--at'))||0)+k*0.14+'s');el.appendChild(sp)});
    });
    // 장면 안 모든 움직임은 장면 시각 + --at 에 (없으면 장면 시작에)
    [].slice.call(s.querySelectorAll('*')).forEach(function(el){
      var v=parseFloat(getComputedStyle(el).getPropertyValue('--at'))||0;el.style.animationDelay=(start+v)+'s';
    });
    // 색종이·눈·하트·거품 (data-kind, data-count)
    [].slice.call(s.querySelectorAll('.particles,.burst')).forEach(function(box){
      var kind=box.dataset.kind||'confetti';var n=Math.min(parseInt(box.dataset.count||'70'),200);
      var colors=(box.dataset.colors||'#ff5a8a,#ffd84d,#5ad1ff,#8cff9e,#c58cff,#ff9f5a').split(',');
      var base=start+(parseFloat(getComputedStyle(box).getPropertyValue('--at'))||0);
      for(var k=0;k<n;k++){var p=document.createElement('i');var c=colors[k%colors.length];var size=(kind==='snow'?6:10)+rnd()*(kind==='confetti'?18:14);
        if(kind==='confetti'){p.style.width=size+'px';p.style.height=size*0.45+'px';p.style.background=c;p.style.borderRadius='2px'}
        else if(kind==='snow'){p.style.width=p.style.height=size+'px';p.style.background='#fff';p.style.borderRadius='50%';p.style.opacity=.85}
        else if(kind==='hearts'){p.textContent='\\u2764';p.style.color=c;p.style.fontSize=size*2+'px'}
        else if(kind==='stars'){p.textContent='\\u2726';p.style.color=c;p.style.fontSize=size*2+'px'}
        else if(kind==='bubbles'){p.style.width=p.style.height=size*2+'px';p.style.border='3px solid '+c;p.style.borderRadius='50%'}
        p.style.left=(rnd()*100)+'%';
        p.style.setProperty('--dx',((rnd()-0.5)*30)+'vw');p.style.setProperty('--rot',((rnd()-0.5)*1440)+'deg');
        p.style.setProperty('--fd',(2.2+rnd()*2.8)+'s');p.style.setProperty('--fdel',(base+rnd()*Math.max(0.2,dur-2))+'s');
        if(box.classList.contains('burst')){var ang=rnd()*Math.PI*2,dist=200+rnd()*600;p.style.setProperty('--bx',Math.cos(ang)*dist+'px');p.style.setProperty('--by',Math.sin(ang)*dist+'px');p.style.setProperty('--fdel',(base+rnd()*0.15)+'s')}
        box.appendChild(p)}
    });
    [].slice.call(s.querySelectorAll('.line path')).forEach(function(p){var at=parseFloat(getComputedStyle(p.closest('.line')).getPropertyValue('--at'))||0;p.style.setProperty('--fdel',(start+at)+'s')});
  });
  document.documentElement.style.setProperty('--total',t+'s');
  window.__dool2Total=t;
})();
`

/** 두리가 쓴 장면 HTML을 영상용 문서로 감싼다 (크기·키트 CSS·스크립트) */
export function motionDocument(body: string, shape: MotionShape, extraCss = ''): string {
  const [w, h] = MOTION_SHAPES[shape]
  const inner = body.replace(/<\/?(?:html|head|body)[^>]*>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
  return `<!doctype html><html lang="ko" style="--w:${w}px;--h:${h}px"><head><meta charset="utf-8"><style>${CSS}${extraCss}</style></head><body>${inner}<script>${JS}</script></body></html>`
}

/** 장면 길이 합 (data-dur, 없으면 3초). 렌더 길이를 정할 때 */
export function motionLength(body: string): number {
  let t = 0
  for (const m of body.matchAll(/<section[^>]*class="[^"]*\bscene\b[^"]*"[^>]*>/gi)) {
    const tag = m[0]
    const start = /data-start="([\d.]+)"/.exec(tag)
    const dur = Number(/data-dur="([\d.]+)"/.exec(tag)?.[1] ?? 3)
    t = (start ? Number(start[1]) : t) + dur
  }
  return t
}

/** 도구 설명에 붙는 키트 안내 */
export const MOTION_GUIDE =
  '장면은 <section class="scene" data-dur="3" data-in="fade|zoom|slide|wipe|circle|flash">…</section>를 차례로(1.5~4초). ' +
  '장면 안 요소는 style="--at:.4s"로 나오는 때를 주고 움직임 이름표를 단다: pop·rise·drop·slam·zoom·left·right·spin·stamp·reveal·blur·type(style="--n:글자수")·polaroid(style="--r:-6deg")·words(낱말마다 차례로, 키네틱 타이포)·marker(형광펜). ' +
  '계속 움직임: float·pulse·wiggle. 글자 크기: huge·big·mid·small, 꾸밈: shadow·outline·pill·box, 자리: top·bottom. ' +
  '사진: <img class="bg kenburns|pan" src="file:///경로">(장면 배경, 위에 class="dim"이면 글자가 잘 보임), <img class="photo zoom">, <div class="polaroid"><img src=…>글</div>, 여러 장은 <div class="collage">. ' +
  '배경: 장면에 class="grad"(style="--c1:#…;--c2:#…;--c3:#…" 움직이는 그라데이션)·"paper"(종이 질감)·"grain"(필름 입자)·"letterbox"(영화 띠)·style="background:#…". ' +
  '장식: <div class="particles" data-kind="confetti|snow|hearts|stars|bubbles" data-count="80"></div>(위에서 떨어짐, class="particles up"이면 올라감), <div class="burst" data-kind="confetti" style="--at:.2s"></div>(터짐), ' +
  '<svg class="line" viewBox="0 0 1080 1920"><path d="M…"/></svg>(선 그리기), <div class="progress"></div>. 스크립트는 쓰지 않는다(키트가 시간을 맞춘다).'
