// Motion kit (video_motion): Dool2 writes only scenes and class names, and the movement is decided here.
// The PC app shoots in a hidden window, setting the time frame by frame (currentTime of document.getAnimations), so
// all movement must be CSS animation. The script below runs once on open and makes scene times, letter splitting and confetti
// (11-23 user: "motion graphics are too monotonous" → references: kinetic type, confetti, polaroid collage, texture, layer depth).

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
/* Scenes coming in and going out (the script sets the times) */
/* The earlier scene leaves after the next one fully covers it (end + 0.6 s) — if it vanished first, a black screen showed between circle and slide transitions (11-23) */
.scene{animation:var(--in,s-fade) .6s cubic-bezier(.2,.8,.2,1) var(--s) both, s-out .2s linear var(--e) forwards}
@keyframes s-fade{from{opacity:0}to{opacity:1}}
@keyframes s-zoom{from{opacity:0;transform:scale(1.25)}to{opacity:1;transform:none}}
@keyframes s-slide{0%{opacity:0}1%{opacity:1;transform:translateY(100%)}100%{opacity:1;transform:none}}
@keyframes s-wipe{0%{opacity:0}1%{opacity:1;clip-path:inset(0 100% 0 0)}100%{opacity:1;clip-path:inset(0 0 0 0)}}
@keyframes s-circle{0%{opacity:0}1%{opacity:1;clip-path:circle(0% at 50% 50%)}100%{opacity:1;clip-path:circle(75% at 50% 50%)}}
@keyframes s-flash{0%{opacity:0}1%{opacity:1;filter:brightness(4)}100%{opacity:1;filter:none}}
@keyframes s-out{to{opacity:0}}
.scene.last{animation:var(--in,s-fade) .6s cubic-bezier(.2,.8,.2,1) var(--s) both}
/* Text size */
.huge{font-size:calc(var(--w)*.15);font-weight:900;line-height:1.05;letter-spacing:-.03em}
.big{font-size:calc(var(--w)*.10);font-weight:800;line-height:1.15;letter-spacing:-.02em}
.mid{font-size:calc(var(--w)*.065);font-weight:700;line-height:1.3}
.small{font-size:calc(var(--w)*.042);font-weight:600;line-height:1.45;opacity:.9}
.shadow{text-shadow:0 6px 30px rgba(0,0,0,.45)}
.outline{-webkit-text-stroke:calc(var(--w)*.006) currentColor;color:transparent}
.pill{display:inline-block;padding:.25em .7em;border-radius:999px;background:var(--accent,#ff5a8a);color:#fff}
.box{padding:.4em .7em;border-radius:.4em;background:rgba(0,0,0,.45)}
.top{position:absolute;top:8%;left:0;right:0}.bottom{position:absolute;bottom:9%;left:0;right:0}
/* Entrance movements (style="--at:.4s" sets the time inside the scene) */
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
/* Word by word in turn (kinetic type): <h1 class="words big">Happy birthday Sky</h1> */
.words>span{display:inline-block;animation-name:k-word;animation-duration:.5s;margin:0 .12em}
@keyframes k-word{0%{opacity:0;transform:translateY(60%) rotate(6deg)}100%{opacity:1;transform:none}}
/* Highlighter underline */
.marker{position:relative;display:inline-block;z-index:0}
.marker::after{content:"";position:absolute;left:-.1em;right:-.1em;bottom:.08em;height:.38em;background:var(--accent,#ffd84d);z-index:-1;transform-origin:left;animation-name:k-mark;animation-duration:.6s}
@keyframes k-mark{from{transform:scaleX(0)}to{transform:scaleX(1)}}
/* Things that keep moving (all through the scene) */
.float{animation:k-float 3s ease-in-out infinite alternate}
@keyframes k-float{from{transform:translateY(-3%)}to{transform:translateY(3%)}}
.pulse{animation:k-pulse 1.2s ease-in-out infinite alternate}
@keyframes k-pulse{from{transform:scale(1)}to{transform:scale(1.06)}}
.wiggle{animation:k-wig .5s ease-in-out infinite alternate}
@keyframes k-wig{from{transform:rotate(-3deg)}to{transform:rotate(3deg)}}
/* Photos */
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
/* Backgrounds */
.grad::before{content:"";position:absolute;inset:0;z-index:-3;background:linear-gradient(135deg,var(--c1,#ff8fb1),var(--c2,#7cc8ff),var(--c3,#ffe27a));background-size:300% 300%;animation:k-grad var(--d,6s) ease-in-out var(--s,0s) both}
@keyframes k-grad{from{background-position:0% 50%}to{background-position:100% 50%}}
.paper{background:#f6efe3 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3'/%3E%3CfeColorMatrix values='0 0 0 0 .4 0 0 0 0 .35 0 0 0 0 .3 0 0 0 .09 0'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)'/%3E%3C/svg%3E");color:#2b2622}
.grain::after{content:"";position:absolute;inset:-50%;z-index:4;pointer-events:none;opacity:.16;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");animation:k-grain .5s steps(4) infinite}
@keyframes k-grain{0%{transform:translate(0,0)}25%{transform:translate(-3%,2%)}50%{transform:translate(2%,-3%)}75%{transform:translate(-2%,-1%)}}
.letterbox::before,.letterbox::after{content:"";position:absolute;left:0;right:0;height:9%;background:#000;z-index:5;animation:k-lb .8s ease-out var(--s,0s) both}
.letterbox::before{top:0}.letterbox::after{bottom:0}
@keyframes k-lb{from{height:0}to{height:9%}}
/* Decoration */
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
/* ── Advanced (11-23 "looks a bit cheap" → design fonts, layers, camera, light) ── */
html{font-synthesis:none}
h1,h2,.f-title{font-family:"Black Han Sans","Pretendard","Apple SD Gothic Neo",sans-serif;font-weight:400;letter-spacing:-.01em;line-height:1}
.f-round{font-family:"Jua","Pretendard",sans-serif;font-weight:400}
.f-hand{font-family:"Nanum Pen Script","Pretendard",cursive;font-weight:400;line-height:1.1}
.f-serif{font-family:"Gowun Batang","Nanum Myeongjo",serif;font-weight:700;letter-spacing:-.02em}
.f-soft{font-family:"Gowun Dodum","Pretendard",sans-serif;font-weight:400}
.f-sans{font-family:"Pretendard","Apple SD Gothic Neo","Malgun Gothic",sans-serif}
.scene{perspective:1400px}
/* Camera: wrap a scene background and it slowly pushes in (push) or pulls out (pull) all through the scene */
.cam{position:absolute;inset:0;z-index:-1;animation:k-cam var(--d,4s) cubic-bezier(.16,1,.3,1) both}
.cam.pull{animation-name:k-pull}
@keyframes k-cam{from{transform:scale(1.2) translateY(2%)}to{transform:none}}
@keyframes k-pull{from{transform:none}to{transform:scale(1.15)}}
.cam>.bg{z-index:0}
img.blurbg{position:absolute;inset:-6%;width:112%;height:112%;object-fit:cover;filter:blur(36px) saturate(1.35) brightness(.55);z-index:-2}
.cam>img.blurbg{z-index:0}
/* Light leak and dark edges (scene class="leak vig") */
.fx-leak{position:absolute;inset:-25%;z-index:2;pointer-events:none;mix-blend-mode:screen;background:radial-gradient(40% 30% at 20% 30%,var(--leak1,rgba(255,170,120,.55)),transparent 70%),radial-gradient(35% 25% at 85% 70%,var(--leak2,rgba(255,110,200,.42)),transparent 70%);animation:k-leak var(--d,4s) ease-in-out both}
@keyframes k-leak{from{transform:translate(-7%,-5%) rotate(-5deg);opacity:.25}50%{opacity:1}to{transform:translate(7%,5%) rotate(5deg);opacity:.55}}
.fx-vig{position:absolute;inset:0;z-index:2;pointer-events:none;background:radial-gradient(ellipse at center,transparent 48%,rgba(0,0,0,.6) 100%)}
/* Each letter rises in 3D (chars) — a word is never broken */
.chars .cw{display:inline-block;white-space:nowrap}
.chars .ch{display:inline-block;animation:k-ch .9s cubic-bezier(.16,1,.3,1) both}
@keyframes k-ch{0%{opacity:0;transform:translateY(70%) rotateX(-90deg);filter:blur(12px)}100%{opacity:1;transform:none;filter:none}}
.glow{text-shadow:0 0 calc(var(--w)*.03) var(--glow,rgba(255,220,150,.7)),0 calc(var(--w)*.01) calc(var(--w)*.04) rgba(0,0,0,.45)}
.gold,.gold .ch{background:linear-gradient(180deg,#fff6d5,#ffd36b 45%,#e0a43a);-webkit-background-clip:text;background-clip:text;color:transparent}
.gold{filter:drop-shadow(0 8px 24px rgba(0,0,0,.4))}
.gold.chars{background:none}
/* 3D photo card (style="--ry:-25deg;--rz:-6deg", place it with left/top and position:absolute) */
.card3d{position:relative;width:62%;border-radius:calc(var(--w)*.026);overflow:hidden;box-shadow:0 calc(var(--w)*.05) calc(var(--w)*.11) rgba(0,0,0,.55),0 0 0 calc(var(--w)*.009) var(--edge,#fff);animation:k-card 1.3s cubic-bezier(.16,1,.3,1) both;transform:rotateY(calc(var(--ry,20deg)*.25)) rotateZ(var(--rz,-5deg))}
.card3d img,.card3d video{display:block;width:100%;height:100%;object-fit:cover}
@keyframes k-card{from{opacity:0;transform:translateZ(-600px) rotateY(var(--ry,20deg)) rotateZ(var(--rz,-5deg)) translateY(30%)}to{opacity:1;transform:rotateY(calc(var(--ry,20deg)*.25)) rotateZ(var(--rz,-5deg))}}
/* A sweep of sparkling light (card, photo, text box) */
.sheen{position:relative;overflow:hidden}
.sheen::after{content:"";position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(105deg,transparent 35%,rgba(255,255,255,.5) 50%,transparent 65%);transform:translateX(-130%);animation:k-sheen 1.1s ease-in-out both;animation-delay:calc(var(--delay,0s) + .7s)}
@keyframes k-sheen{to{transform:translateX(130%)}}
.marker::after{animation-delay:var(--delay,0s)}
/* Thin accent line and small heading */
.rule{width:0;height:calc(var(--w)*.006);border-radius:9px;background:var(--accent,#ffd84d);animation:k-rule .8s cubic-bezier(.16,1,.3,1) both}
@keyframes k-rule{to{width:var(--len,40%)}}
.eyebrow{font-family:"Gowun Dodum","Pretendard",sans-serif;font-size:calc(var(--w)*.038);letter-spacing:.35em;opacity:.9}
.glass{padding:.5em .9em;border-radius:.5em;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);backdrop-filter:blur(14px)}
`

/** Design fonts (the render window allows only https GET; offline falls back to the default font) */
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
    // Split into words
    [].slice.call(s.querySelectorAll('.words')).forEach(function(el){
      var ws=el.textContent.trim().split(/\\s+/);el.textContent='';
      ws.forEach(function(w,k){var sp=document.createElement('span');sp.textContent=w;sp.style.setProperty('--at',(parseFloat(getComputedStyle(el).getPropertyValue('--at'))||0)+k*0.14+'s');el.appendChild(sp)});
    });
    // Split into letters (chars): a word stays together, and each letter is 0.06 s later
    [].slice.call(s.querySelectorAll('.chars')).forEach(function(el){
      var at=parseFloat(getComputedStyle(el).getPropertyValue('--at'))||0;var ws=el.textContent.trim().split(/\\s+/);var k=0;el.textContent='';
      ws.forEach(function(w,wi){if(wi)el.appendChild(document.createTextNode(' '));var cw=document.createElement('span');cw.className='cw';
        Array.from(w).forEach(function(c){var ch=document.createElement('span');ch.className='ch';ch.textContent=c;ch.style.setProperty('--at',(at+k*0.06)+'s');k++;cw.appendChild(ch)});
        el.appendChild(cw)});
    });
    // Light leak and dark edges
    if(s.classList.contains('leak')){var lk=document.createElement('div');lk.className='fx-leak';s.appendChild(lk)}
    if(s.classList.contains('vig')){var vg=document.createElement('div');vg.className='fx-vig';s.appendChild(vg)}
    // All movement in a scene runs at scene time + --at (at the scene start if absent)
    [].slice.call(s.querySelectorAll('*')).forEach(function(el){
      var v=parseFloat(getComputedStyle(el).getPropertyValue('--at'))||0;el.style.animationDelay=(start+v)+'s';el.style.setProperty('--delay',(start+v)+'s');
    });
    // Confetti, snow, hearts, bubbles (data-kind, data-count)
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
  // If big text overflows the screen, shrink it until it fits on one line (it used to break like "BIRTHD/AY")
  function fit(){[].slice.call(document.querySelectorAll('h1,h2,.huge,.big,.fit')).forEach(function(el){
    var p=el.parentElement;if(!p)return;var ps=getComputedStyle(p);var max=p.clientWidth-parseFloat(ps.paddingLeft)-parseFloat(ps.paddingRight);
    // Text with a fixed place (.top, .bottom etc., absolute) is checked only for overflow within its own width
    var free=/absolute|fixed/.test(getComputedStyle(el).position);
    var size=parseFloat(getComputedStyle(el).fontSize);var g=0;
    while(((!free&&el.offsetWidth>max+1)||el.scrollWidth>el.clientWidth+1)&&size>16&&g++<40){size*=0.94;el.style.fontSize=size+'px'}
  })}
  fit();window.__dool2Fit=(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(fit);
})();
`

/** Wrap the scene HTML Dool2 wrote into a video document (size, kit CSS, script) */
export function motionDocument(body: string, shape: MotionShape, extraCss = ''): string {
  const [w, h] = MOTION_SHAPES[shape]
  const inner = body.replace(/<\/?(?:html|head|body)[^>]*>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
  return `<!doctype html><html lang="ko" style="--w:${w}px;--h:${h}px"><head><meta charset="utf-8"><link rel="stylesheet" href="${FONTS}"><style>${CSS}${extraCss}</style></head><body>${inner}<script>${JS}</script></body></html>`
}

/** Sum of scene lengths (data-dur, 3 s if absent). Used to set the render length */
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

/** Quality basics common to all styles (11-23 user "looks a bit cheap" — caused by scenes with only a plain background, the default font and an entrance) */
export const MOTION_QUALITY = [
  'Fonts: titles (h1, h2) default to a bold design font (f-title). Switch by mood to f-round (round and cute), f-hand (handwriting) or f-serif (serif, sentimental and refined), and use f-soft for body text',
  'Layers: every scene has three or more layers: background (photo bg, blurred photo blurbg, grad) + middle (card3d, polaroid, photo) + text + effects (leak, vig, particles). At most one scene per video with just text on a plain background',
  'Camera: put the background inside <div class="cam"> (slowly pushes in all through the scene, pulls out with pull), or keep it always moving a little with kenburns or pan',
  'Titles use chars (each letter rises in 3D) or words, with one key line per screen. Emphasis with glow, gold, marker; an eyebrow (small heading) above and a rule (accent line) below',
  'If there are no photos, first make one or two background pictures without text with image_make and use them as bg or blurbg (for example: "pastel balloons and sparkling bokeh, no text, vertical 9:16")',
  'If the background behind text is a busy picture or photo, lay it as blurbg (blurred) instead of bg so the text does not get lost',
  'Look at the scene contact sheet, and fix and remake with replace any scene where text is cut off, lost in the background or a photo is empty',
]

/**
 * Style book (video_style): references (2026 shorts and reels trend — kinetic type, fast cuts, texture, collage, layer depth, light leak,
 * birthday template — confetti, 3D photo cards, titles that rise letter by letter) sorted by situation. Dool2 first picks a matching style and then plans the storyboard
 */
export const MOTION_STYLES = [
  {
    id: 'reels',
    name: 'Reels and Shorts (fast and intense)',
    when: 'Instagram Reels or YouTube Shorts feel, "trendy style", a short video to send to a friend',
    rules: [
      'Scenes of 1.2 to 1.8 s, 6 to 10 scenes. Catch the eye within the first second with the strongest scene (big text slam + burst)',
      'Alternate backgrounds between a photo (bg inside cam) and vivid colors (#ff2e63, #08d9d6, #252a34, #ffd23f), with flash, zoom or slide transitions',
      'Text in huge and chars, 3 to 6 characters per screen, captions as pill or glass at the bottom. Wiggle on emoji stickers',
      'A progress bar and a one-line closing in the last scene',
    ],
    example:
      '<section class="scene vig" data-dur="1.4" data-in="flash" style="background:#ff2e63"><div class="burst" data-kind="confetti" data-count="90"></div><h1 class="huge slam glow">D-DAY!</h1></section>' +
      '<section class="scene leak vig" data-dur="1.6" data-in="zoom"><div class="cam"><img class="bg" src="file:///photo"></div><h1 class="chars huge glow" style="--at:.1s">STAR OF THE DAY</h1><p class="mid glass rise bottom f-soft" style="--at:.7s">Sky 🎉</p></section>',
  },
  {
    id: 'birthday',
    name: 'Birthday party (bright and sparkling)',
    when: 'A birthday for a child, family or friend, a first birthday party, a congratulation message',
    rules: [
      "Scenes of 2.8 to 3.6 s, 4 to 7 scenes. The first scene lays the guest of honor's photo blurred as blurbg with leak vig + a chars name (glow) + a yellow accent line",
      'Photos: overlap two or three card3d with --ry and --rz tilted opposite ways (sheen), and one line in f-hand handwriting',
      'Burst confetti at the start and end, particles stars or bubbles up in the scenes between. End with HAPPY BIRTHDAY in chars (gold)',
      'If there are no photos, make a pastel balloon or bokeh background with image_make',
    ],
    example:
      '<section class="scene leak vig" data-dur="3.4" data-in="fade" style="background:#140b22"><div class="cam"><img class="blurbg" src="file:///guest-photo"></div><p class="eyebrow blur" style="--at:.2s">2026 · 12 · 05</p><h1 class="chars glow" style="font-size:calc(var(--w)*.2);--at:.35s">Sky</h1><h2 class="chars glow" style="font-size:calc(var(--w)*.13);color:#ffd84d;--at:.75s">Happy birthday</h2><div class="rule" style="--at:1.3s"></div><div class="particles up" data-kind="bubbles" data-count="16" data-colors="rgba(255,255,255,.6)"></div></section>' +
      '<section class="scene vig" data-dur="3.4" data-in="zoom" style="background:#1a1030"><img class="blurbg" src="file:///background"><div class="card3d sheen" style="position:absolute;width:58%;left:8%;top:14%;--ry:-30deg;--rz:-7deg;--at:.1s"><img src="file:///photo1"></div><div class="card3d sheen" style="position:absolute;width:52%;left:40%;top:40%;--ry:30deg;--rz:6deg;--at:.45s"><img src="file:///photo2"></div><p class="f-hand big rise bottom glow" style="--at:1.1s">Our little party 🎈</p></section>' +
      '<section class="scene leak vig" data-dur="3.6" data-in="circle" style="background:#0b0714"><div class="cam"><img class="blurbg" src="file:///background"></div><div class="burst" data-kind="confetti" data-count="140" style="--at:.4s"></div><h1 class="chars huge gold" style="--at:.3s">HAPPY BIRTHDAY</h1><p class="f-soft small rise" style="--at:1.3s">To our dear Sky, from Mom and Dad</p></section>',
  },
  {
    id: 'vlog',
    name: 'Travel and daily vlog (cinematic)',
    when: 'Travel, weekend and daily records, highlights, "mood vlog"',
    rules: [
      'Scenes of 3 to 4 s, a film feel with letterbox + grain + vig, photos and videos as bg inside cam or with kenburns or pan',
      'Put the date and place as an eyebrow (blur) in the first scene, the title in f-serif big reveal. A warm leak (--leak1:rgba(255,180,110,.5))',
      'Mostly fade transitions, sometimes wipe. Little text (one line per scene), and now and then float a photo as card3d',
      'If there is a route, draw the line with an svg line',
    ],
    example:
      '<section class="scene letterbox grain leak vig" data-dur="3.5" data-in="fade"><div class="cam"><img class="bg" src="file:///photo"></div><p class="eyebrow blur" style="--at:.3s">2026.12.20 · Seongsan</p><h1 class="f-serif big reveal glow" style="--at:.6s">Jeju, winter</h1></section>',
  },
  {
    id: 'memory',
    name: 'Memories and mood (warm and slow)',
    when: 'Family memories, anniversaries, a video gift for parents, growth records',
    rules: [
      'Scenes of 3.5 to 4.5 s, a paper background or a photo blurbg + a warm leak, text in f-serif or f-hand',
      'Photos as polaroid and card3d, slowly (drift away a little with cam pull). Words short like a handwritten letter, with marker on the important words',
      'Only fade transitions. Decoration: a few particles hearts (30 or fewer)',
    ],
    example:
      '<section class="scene paper" data-dur="4" data-in="fade" style="color:#3b2f27"><div class="polaroid drop" style="--r:-4deg"><img src="file:///photo">Spring 2019</div><p class="f-hand big rise" style="--at:1s">The day you took your first steps, <span class="marker" style="--at:1.6s;--accent:#f4c7a1">remember?</span></p></section>' +
      '<section class="scene leak vig" data-dur="4.2" data-in="fade" style="--leak1:rgba(255,190,120,.5)"><div class="cam pull"><img class="blurbg" src="file:///photo2"></div><div class="card3d sheen" style="width:66%;--ry:-18deg;--rz:-3deg"><img src="file:///photo2"></div><h2 class="f-serif mid blur" style="--at:1.2s">Thank you for always being there</h2></section>',
  },
  {
    id: 'promo',
    name: 'Shop and product promotion (bold and clear)',
    when: 'Shop events, sales, new menu items, product introductions, promotion on local marketplaces and Instagram',
    rules: [
      'Scenes of 1.5 to 2.5 s, a dark background + product photo in cam or blurbg, white huge text with slam or chars',
      'Price and benefits as pill pop (sheen), emphasis with marker or gold. Product photos as card3d or photo zoom + pulse',
      'At the end, sum up the shop name, place and period in a glass box, with a progress bar',
    ],
    example:
      '<section class="scene vig" data-dur="1.8" data-in="flash" style="background:#111"><h1 class="huge slam glow">WINTER ONLY</h1><p class="big pill pop sheen" style="--at:.6s;--accent:#ff3b3b">30% OFF</p></section>' +
      '<section class="scene leak vig" data-dur="2.2" data-in="zoom" style="background:#1b120c"><img class="blurbg" src="file:///product-photo"><div class="card3d sheen" style="width:64%;--ry:22deg;--rz:4deg"><img src="file:///product-photo"></div><p class="mid rise f-soft" style="--at:.5s">Warm <span class="marker">hotteok set</span></p></section>',
  },
  {
    id: 'cardnews',
    name: 'Notice and card news (clean information)',
    when: 'Meeting notices, guidance, organizing information, explaining steps and methods',
    rules: [
      'Scenes of 2.5 to 3 s, a white background (#fafafa) with dark text, or navy (#14213d) with white text + vig, titles in f-title',
      'A number (pill) and a big title in chars for each scene, the explanation in two or three lines of f-soft small rise, a rule below',
      'Key numbers and dates in huge pop, transitions steady with slide or wipe',
    ],
    example:
      '<section class="scene vig" data-dur="2.8" data-in="slide" style="background:#14213d"><p class="pill small pop" style="--accent:#fca311">01</p><h2 class="big chars" style="--at:.3s">Meeting place</h2><div class="rule" style="--at:.8s;--accent:#fca311"></div><p class="mid rise f-soft" style="--at:.9s">Gangnam Station, Exit 11</p></section>',
  },
] as const

/** Style book text (one style or the whole list) */
export function styleGuide(id?: string): string {
  const pick = MOTION_STYLES.find((s) => s.id === id)
  if (pick)
    return [
      `## ${pick.name} (${pick.id})`,
      `When: ${pick.when}`,
      ...pick.rules.map((r) => `- ${r}`),
      `Example scenes:\n${pick.example}`,
      'Quality basics (all styles):',
      ...MOTION_QUALITY.map((r) => `- ${r}`),
    ].join('\n')
  return [
    'Video styles (pick one with style and call again to get its rules and example scenes):',
    ...MOTION_STYLES.map((s) => `- ${s.id}: ${s.name} — ${s.when}`),
    'If the user gives a reference (a link, or "like XX"), find that video or similar ones on the web, write its color, speed, text and transition traits in 3 lines, and plan the storyboard by adding them to the closest style.',
  ].join('\n')
}
