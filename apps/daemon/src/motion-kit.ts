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
/* 앞 장면은 다음 장면이 다 덮은 뒤에(끝+0.6초) 빠진다 — 먼저 사라지면 원·밀기 전환 사이로 검은 화면이 보였다(11-23) */
.scene{animation:var(--in,s-fade) .6s cubic-bezier(.2,.8,.2,1) var(--s) both, s-out .2s linear var(--e) forwards}
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
/* ── 고급 (11-23 "조금 짜치네" → 디자인 글꼴·겹·카메라·빛) ── */
html{font-synthesis:none}
h1,h2,.f-title{font-family:"Black Han Sans","Pretendard","Apple SD Gothic Neo",sans-serif;font-weight:400;letter-spacing:-.01em;line-height:1}
.f-round{font-family:"Jua","Pretendard",sans-serif;font-weight:400}
.f-hand{font-family:"Nanum Pen Script","Pretendard",cursive;font-weight:400;line-height:1.1}
.f-serif{font-family:"Gowun Batang","Nanum Myeongjo",serif;font-weight:700;letter-spacing:-.02em}
.f-soft{font-family:"Gowun Dodum","Pretendard",sans-serif;font-weight:400}
.f-sans{font-family:"Pretendard","Apple SD Gothic Neo","Malgun Gothic",sans-serif}
.scene{perspective:1400px}
/* 카메라: 장면 배경을 감싸면 장면 내내 천천히 밀고 들어간다 (push) 또는 빠진다 (pull) */
.cam{position:absolute;inset:0;z-index:-1;animation:k-cam var(--d,4s) cubic-bezier(.16,1,.3,1) both}
.cam.pull{animation-name:k-pull}
@keyframes k-cam{from{transform:scale(1.2) translateY(2%)}to{transform:none}}
@keyframes k-pull{from{transform:none}to{transform:scale(1.15)}}
.cam>.bg{z-index:0}
img.blurbg{position:absolute;inset:-6%;width:112%;height:112%;object-fit:cover;filter:blur(36px) saturate(1.35) brightness(.55);z-index:-2}
.cam>img.blurbg{z-index:0}
/* 빛 번짐·가장자리 어둡게 (장면 class="leak vig") */
.fx-leak{position:absolute;inset:-25%;z-index:2;pointer-events:none;mix-blend-mode:screen;background:radial-gradient(40% 30% at 20% 30%,var(--leak1,rgba(255,170,120,.55)),transparent 70%),radial-gradient(35% 25% at 85% 70%,var(--leak2,rgba(255,110,200,.42)),transparent 70%);animation:k-leak var(--d,4s) ease-in-out both}
@keyframes k-leak{from{transform:translate(-7%,-5%) rotate(-5deg);opacity:.25}50%{opacity:1}to{transform:translate(7%,5%) rotate(5deg);opacity:.55}}
.fx-vig{position:absolute;inset:0;z-index:2;pointer-events:none;background:radial-gradient(ellipse at center,transparent 48%,rgba(0,0,0,.6) 100%)}
/* 글자마다 입체로 떠오름 (chars) — 낱말은 끊기지 않는다 */
.chars .cw{display:inline-block;white-space:nowrap}
.chars .ch{display:inline-block;animation:k-ch .9s cubic-bezier(.16,1,.3,1) both}
@keyframes k-ch{0%{opacity:0;transform:translateY(70%) rotateX(-90deg);filter:blur(12px)}100%{opacity:1;transform:none;filter:none}}
.glow{text-shadow:0 0 calc(var(--w)*.03) var(--glow,rgba(255,220,150,.7)),0 calc(var(--w)*.01) calc(var(--w)*.04) rgba(0,0,0,.45)}
.gold,.gold .ch{background:linear-gradient(180deg,#fff6d5,#ffd36b 45%,#e0a43a);-webkit-background-clip:text;background-clip:text;color:transparent}
.gold{filter:drop-shadow(0 8px 24px rgba(0,0,0,.4))}
.gold.chars{background:none}
/* 3D 사진 카드 (style="--ry:-25deg;--rz:-6deg", 자리는 left/top과 position:absolute로) */
.card3d{position:relative;width:62%;border-radius:calc(var(--w)*.026);overflow:hidden;box-shadow:0 calc(var(--w)*.05) calc(var(--w)*.11) rgba(0,0,0,.55),0 0 0 calc(var(--w)*.009) var(--edge,#fff);animation:k-card 1.3s cubic-bezier(.16,1,.3,1) both;transform:rotateY(calc(var(--ry,20deg)*.25)) rotateZ(var(--rz,-5deg))}
.card3d img,.card3d video{display:block;width:100%;height:100%;object-fit:cover}
@keyframes k-card{from{opacity:0;transform:translateZ(-600px) rotateY(var(--ry,20deg)) rotateZ(var(--rz,-5deg)) translateY(30%)}to{opacity:1;transform:rotateY(calc(var(--ry,20deg)*.25)) rotateZ(var(--rz,-5deg))}}
/* 반짝 훑는 빛 (카드·사진·글자 상자) */
.sheen{position:relative;overflow:hidden}
.sheen::after{content:"";position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(105deg,transparent 35%,rgba(255,255,255,.5) 50%,transparent 65%);transform:translateX(-130%);animation:k-sheen 1.1s ease-in-out both;animation-delay:calc(var(--delay,0s) + .7s)}
@keyframes k-sheen{to{transform:translateX(130%)}}
.marker::after{animation-delay:var(--delay,0s)}
/* 가는 강조선·작은 머리말 */
.rule{width:0;height:calc(var(--w)*.006);border-radius:9px;background:var(--accent,#ffd84d);animation:k-rule .8s cubic-bezier(.16,1,.3,1) both}
@keyframes k-rule{to{width:var(--len,40%)}}
.eyebrow{font-family:"Gowun Dodum","Pretendard",sans-serif;font-size:calc(var(--w)*.038);letter-spacing:.35em;opacity:.9}
.glass{padding:.5em .9em;border-radius:.5em;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);backdrop-filter:blur(14px)}
`

/** 디자인 글꼴 (render 창은 https GET만 허용; 오프라인이면 기본 글꼴로) */
const FONTS =
  'https://fonts.googleapis.com/css2?family=Black+Han+Sans&family=Jua&family=Nanum+Pen+Script&family=Gowun+Dodum&family=Gowun+Batang:wght@700&display=block'

const JS = `
(function(){
  var seed=7;function rnd(){seed=(seed*16807)%2147483647;return seed/2147483647}
  var scenes=[].slice.call(document.querySelectorAll('.scene'));var t=0;
  scenes.forEach(function(s,i){
    var start=s.dataset.start!=null?parseFloat(s.dataset.start):t;var dur=parseFloat(s.dataset.dur||'3');
    var end=start+dur;t=end;
    s.style.setProperty('--s',start+'s');s.style.setProperty('--e',(end+0.6)+'s');s.style.setProperty('--d',dur+'s');
    if(s.dataset.in)s.style.setProperty('--in','s-'+s.dataset.in);
    [].slice.call(s.querySelectorAll('video')).forEach(function(v){v.muted=true;v.dataset.sceneStart=String(start);v.preload='auto'});
    if(i===scenes.length-1)s.classList.add('last');
    s.style.zIndex=10+i;
    // 낱말 나누기
    [].slice.call(s.querySelectorAll('.words')).forEach(function(el){
      var ws=el.textContent.trim().split(/\\s+/);el.textContent='';
      ws.forEach(function(w,k){var sp=document.createElement('span');sp.textContent=w;sp.style.setProperty('--at',(parseFloat(getComputedStyle(el).getPropertyValue('--at'))||0)+k*0.14+'s');el.appendChild(sp)});
    });
    // 글자 나누기 (chars): 낱말은 붙여 두고 글자마다 0.06초씩
    [].slice.call(s.querySelectorAll('.chars')).forEach(function(el){
      var at=parseFloat(getComputedStyle(el).getPropertyValue('--at'))||0;var ws=el.textContent.trim().split(/\\s+/);var k=0;el.textContent='';
      ws.forEach(function(w,wi){if(wi)el.appendChild(document.createTextNode(' '));var cw=document.createElement('span');cw.className='cw';
        Array.from(w).forEach(function(c){var ch=document.createElement('span');ch.className='ch';ch.textContent=c;ch.style.setProperty('--at',(at+k*0.06)+'s');k++;cw.appendChild(ch)});
        el.appendChild(cw)});
    });
    // 빛 번짐·가장자리 어둡게
    if(s.classList.contains('leak')){var lk=document.createElement('div');lk.className='fx-leak';s.appendChild(lk)}
    if(s.classList.contains('vig')){var vg=document.createElement('div');vg.className='fx-vig';s.appendChild(vg)}
    // 장면 안 모든 움직임은 장면 시각 + --at 에 (없으면 장면 시작에)
    [].slice.call(s.querySelectorAll('*')).forEach(function(el){
      var v=parseFloat(getComputedStyle(el).getPropertyValue('--at'))||0;el.style.animationDelay=(start+v)+'s';el.style.setProperty('--delay',(start+v)+'s');
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
  // 큰 글자가 화면 밖으로 넘치면 한 줄에 들어갈 때까지 줄인다 ("BIRTHD/AY"처럼 끊기던 것)
  function fit(){[].slice.call(document.querySelectorAll('h1,h2,.huge,.big,.fit')).forEach(function(el){
    var p=el.parentElement;if(!p)return;var ps=getComputedStyle(p);var max=p.clientWidth-parseFloat(ps.paddingLeft)-parseFloat(ps.paddingRight);
    // 자리를 정한 글자(.top·.bottom 등 absolute)는 제 폭 안에서 넘치는지만 본다
    var free=/absolute|fixed/.test(getComputedStyle(el).position);
    var size=parseFloat(getComputedStyle(el).fontSize);var g=0;
    while(((!free&&el.offsetWidth>max+1)||el.scrollWidth>el.clientWidth+1)&&size>16&&g++<40){size*=0.94;el.style.fontSize=size+'px'}
  })}
  fit();window.__dool2Fit=(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(fit);
})();
`

/** 두리가 쓴 장면 HTML을 영상용 문서로 감싼다 (크기·키트 CSS·스크립트) */
export function motionDocument(body: string, shape: MotionShape, extraCss = ''): string {
  const [w, h] = MOTION_SHAPES[shape]
  const inner = body.replace(/<\/?(?:html|head|body)[^>]*>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
  return `<!doctype html><html lang="ko" style="--w:${w}px;--h:${h}px"><head><meta charset="utf-8"><link rel="stylesheet" href="${FONTS}"><style>${CSS}${extraCss}</style></head><body>${inner}<script>${JS}</script></body></html>`
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

/** 모든 스타일에 공통인 품질 기본 (11-23 사용자 "조금 짜치네" — 단색 배경+기본 글꼴+등장만 있는 장면이 원인) */
export const MOTION_QUALITY = [
  '글꼴: 제목(h1·h2)은 기본이 굵은 디자인 글꼴(f-title). 분위기에 따라 f-round(둥글고 귀여움)·f-hand(손글씨)·f-serif(명조, 감성·고급)로 바꾸고 본문은 f-soft',
  '겹: 장면마다 배경(사진 bg·흐린 사진 blurbg·grad) + 가운데(card3d·polaroid·photo) + 글자 + 효과(leak·vig·particles) 세 겹 이상. 단색 배경에 글자만 있는 장면은 한 영상에 한 개까지',
  '카메라: 배경은 <div class="cam">(장면 내내 천천히 밀고 들어감, pull이면 빠짐) 안에 넣거나 kenburns·pan으로 늘 조금씩 움직이게',
  '제목은 chars(글자마다 입체로 떠오름)·words로, 한 화면엔 핵심 한 줄. 강조는 glow·gold·marker, 위에 eyebrow(작은 머리말)·아래 rule(강조선)',
  '사진이 없으면 image_make로 글자 없는 배경 그림을 1~2장 먼저 만들어 bg·blurbg로 쓴다(예: "파스텔 풍선과 반짝이는 보케, 글자 없이, 세로 9:16")',
  '글자 뒤 배경이 복잡한 그림·사진이면 bg 대신 blurbg(흐리게)로 깔아 글자가 묻히지 않게',
  '장면 모음을 보고 글자가 잘리거나 배경에 묻히거나 사진이 빈 장면은 고쳐 replace로 다시 만든다',
]

/**
 * 스타일북 (video_style): 레퍼런스(2026 쇼츠·릴스 흐름 — 키네틱 타이포·빠른 컷·질감·콜라주·레이어 깊이·빛 번짐,
 * 생일 템플릿 — 색종이·3D 사진 카드·글자마다 떠오르는 제목)를 상황별로 정리했다. 두리는 먼저 맞는 스타일을 고르고 콘티를 짠다
 */
export const MOTION_STYLES = [
  {
    id: 'reels',
    name: '릴스·쇼츠 (빠르고 강렬)',
    when: '인스타 릴스·유튜브 쇼츠 느낌, "요즘 스타일", 친구에게 보낼 짧은 영상',
    rules: [
      '장면 1.2~1.8초, 6~10장면. 첫 1초 안에 제일 센 장면(큰 글자 slam + burst)으로 시선을 잡는다',
      '배경은 사진(cam 안 bg)과 선명한 색(#ff2e63·#08d9d6·#252a34·#ffd23f)을 번갈아, 전환은 flash·zoom·slide',
      '글자는 huge·chars로 한 화면에 3~6자, 자막은 bottom의 pill·glass. 이모지 스티커에 wiggle',
      '마지막 장면에 progress 막대와 한 줄 마무리',
    ],
    example:
      '<section class="scene vig" data-dur="1.4" data-in="flash" style="background:#ff2e63"><div class="burst" data-kind="confetti" data-count="90"></div><h1 class="huge slam glow">D-DAY!</h1></section>' +
      '<section class="scene leak vig" data-dur="1.6" data-in="zoom"><div class="cam"><img class="bg" src="file:///사진"></div><h1 class="chars huge glow" style="--at:.1s">오늘 주인공</h1><p class="mid glass rise bottom f-soft" style="--at:.7s">하늘이 🎉</p></section>',
  },
  {
    id: 'birthday',
    name: '생일 파티 (화사하고 반짝)',
    when: '아이·가족·친구 생일, 돌잔치, 축하 메시지',
    rules: [
      '장면 2.8~3.6초, 4~7장면. 첫 장면은 주인공 사진을 blurbg로 흐리게 깔고 leak vig + chars 이름(glow) + 노란 강조선',
      '사진은 card3d 두세 장을 --ry·--rz를 반대로 기울여 겹치고(sheen), 한 줄은 f-hand 손글씨로',
      '시작·끝에 burst 색종이, 사이 장면엔 particles stars·bubbles up. 마지막은 HAPPY BIRTHDAY를 chars로(gold)',
      '사진이 없으면 image_make로 파스텔 풍선·보케 배경을 만든다',
    ],
    example:
      '<section class="scene leak vig" data-dur="3.4" data-in="fade" style="background:#140b22"><div class="cam"><img class="blurbg" src="file:///주인공사진"></div><p class="eyebrow blur" style="--at:.2s">2026 · 12 · 05</p><h1 class="chars glow" style="font-size:calc(var(--w)*.2);--at:.35s">하늘이</h1><h2 class="chars glow" style="font-size:calc(var(--w)*.13);color:#ffd84d;--at:.75s">생일 축하해</h2><div class="rule" style="--at:1.3s"></div><div class="particles up" data-kind="bubbles" data-count="16" data-colors="rgba(255,255,255,.6)"></div></section>' +
      '<section class="scene vig" data-dur="3.4" data-in="zoom" style="background:#1a1030"><img class="blurbg" src="file:///배경"><div class="card3d sheen" style="position:absolute;width:58%;left:8%;top:14%;--ry:-30deg;--rz:-7deg;--at:.1s"><img src="file:///사진1"></div><div class="card3d sheen" style="position:absolute;width:52%;left:40%;top:40%;--ry:30deg;--rz:6deg;--at:.45s"><img src="file:///사진2"></div><p class="f-hand big rise bottom glow" style="--at:1.1s">우리 둘의 파티 🎈</p></section>' +
      '<section class="scene leak vig" data-dur="3.6" data-in="circle" style="background:#0b0714"><div class="cam"><img class="blurbg" src="file:///배경"></div><div class="burst" data-kind="confetti" data-count="140" style="--at:.4s"></div><h1 class="chars huge gold" style="--at:.3s">HAPPY BIRTHDAY</h1><p class="f-soft small rise" style="--at:1.3s">사랑하는 하늘이에게, 엄마 아빠가</p></section>',
  },
  {
    id: 'vlog',
    name: '여행·일상 브이로그 (영화처럼)',
    when: '여행·주말·일상 기록, 하이라이트, "감성 브이로그"',
    rules: [
      '장면 3~4초, letterbox + grain + vig로 필름 느낌, 사진·영상은 cam 안 bg나 kenburns·pan',
      '첫 장면에 날짜·장소를 eyebrow로(blur), 제목은 f-serif big reveal. 따뜻한 leak(--leak1:rgba(255,180,110,.5))',
      '전환은 fade 위주, 가끔 wipe. 글자는 적게(장면당 한 줄), 가끔 card3d로 사진 한 장을 띄운다',
      '이동 경로가 있으면 svg line으로 선 그리기',
    ],
    example:
      '<section class="scene letterbox grain leak vig" data-dur="3.5" data-in="fade"><div class="cam"><img class="bg" src="file:///사진"></div><p class="eyebrow blur" style="--at:.3s">2026.12.20 · 성산</p><h1 class="f-serif big reveal glow" style="--at:.6s">제주, 겨울</h1></section>',
  },
  {
    id: 'memory',
    name: '추억·감성 (따뜻하고 느리게)',
    when: '가족 추억, 기념일, 부모님 선물 영상, 성장 기록',
    rules: [
      '장면 3.5~4.5초, paper 배경이나 사진 blurbg + 따뜻한 leak, 글자는 f-serif·f-hand',
      '사진은 polaroid와 card3d를 천천히(cam pull로 살짝 멀어지게). 말은 손편지처럼 짧게, 중요한 낱말에 marker',
      '전환은 fade만. 장식은 particles hearts 조금(30개 이하)',
    ],
    example:
      '<section class="scene paper" data-dur="4" data-in="fade" style="color:#3b2f27"><div class="polaroid drop" style="--r:-4deg"><img src="file:///사진">2019년 봄</div><p class="f-hand big rise" style="--at:1s">처음 걸음마를 뗀 날, <span class="marker" style="--at:1.6s;--accent:#f4c7a1">기억나요?</span></p></section>' +
      '<section class="scene leak vig" data-dur="4.2" data-in="fade" style="--leak1:rgba(255,190,120,.5)"><div class="cam pull"><img class="blurbg" src="file:///사진2"></div><div class="card3d sheen" style="width:66%;--ry:-18deg;--rz:-3deg"><img src="file:///사진2"></div><h2 class="f-serif mid blur" style="--at:1.2s">고마워요, 늘 곁에 있어 줘서</h2></section>',
  },
  {
    id: 'promo',
    name: '가게·제품 홍보 (굵고 선명)',
    when: '가게 이벤트·할인·신메뉴·제품 소개, 당근·인스타 홍보',
    rules: [
      '장면 1.5~2.5초, 어두운 배경 + 제품 사진 cam·blurbg, 흰 huge 글자 slam·chars',
      '가격·혜택은 pill pop(sheen), 강조는 marker·gold. 제품 사진은 card3d나 photo zoom + pulse',
      '마지막에 가게 이름·위치·기간을 정리하고 glass 상자에, progress 막대',
    ],
    example:
      '<section class="scene vig" data-dur="1.8" data-in="flash" style="background:#111"><h1 class="huge slam glow">겨울 한정</h1><p class="big pill pop sheen" style="--at:.6s;--accent:#ff3b3b">30% OFF</p></section>' +
      '<section class="scene leak vig" data-dur="2.2" data-in="zoom" style="background:#1b120c"><img class="blurbg" src="file:///제품사진"><div class="card3d sheen" style="width:64%;--ry:22deg;--rz:4deg"><img src="file:///제품사진"></div><p class="mid rise f-soft" style="--at:.5s">따끈한 <span class="marker">호떡 세트</span></p></section>',
  },
  {
    id: 'cardnews',
    name: '공지·카드뉴스 (깔끔하게 정보)',
    when: '모임 공지, 안내, 정보 정리, 순서·방법 설명',
    rules: [
      '장면 2.5~3초, 흰 배경(#fafafa)과 진한 글자 또는 남색(#14213d)과 흰 글자 + vig, 제목 f-title',
      '장면마다 번호(pill)와 big 제목 chars, 설명은 f-soft small 두세 줄 rise, 아래 rule',
      '핵심 숫자·날짜는 huge pop, 전환은 slide·wipe로 일정하게',
    ],
    example:
      '<section class="scene vig" data-dur="2.8" data-in="slide" style="background:#14213d"><p class="pill small pop" style="--accent:#fca311">01</p><h2 class="big chars" style="--at:.3s">모이는 곳</h2><div class="rule" style="--at:.8s;--accent:#fca311"></div><p class="mid rise f-soft" style="--at:.9s">강남역 11번 출구</p></section>',
  },
] as const

/** 스타일북 글 (한 스타일 또는 전체 목록) */
export function styleGuide(id?: string): string {
  const pick = MOTION_STYLES.find((s) => s.id === id)
  if (pick)
    return [
      `## ${pick.name} (${pick.id})`,
      `언제: ${pick.when}`,
      ...pick.rules.map((r) => `- ${r}`),
      `예시 장면:\n${pick.example}`,
      '품질 기본 (모든 스타일):',
      ...MOTION_QUALITY.map((r) => `- ${r}`),
    ].join('\n')
  return [
    '영상 스타일 (style로 하나를 골라 다시 부르면 규칙·예시 장면이 와요):',
    ...MOTION_STYLES.map((s) => `- ${s.id}: ${s.name} — ${s.when}`),
    '사용자가 레퍼런스(링크·"○○처럼")를 주면 웹에서 그 영상·비슷한 영상을 찾아 색·속도·글자·전환 특징을 3줄로 적고, 가장 가까운 스타일에 덧붙여 콘티를 짜요.',
  ].join('\n')
}
