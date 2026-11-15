// 3D 두리: 말랑한 네모 몸 + 콘센트 얼굴(두 눈 + 열쇠 구멍 입) + 짧은 두 발. 랜딩의 두리와 같은 모양.
// 표정 6개(idle·thinking·working·asking·done·sleeping)는 눈과 머리 옆 소품으로 바꾼다.
//
// 쓰는 곳 두 가지:
//  - 작은 자리: doori/*.webp (이 파일로 미리 뽑은 정지 그림, doori-render.html로 다시 뽑는다)
//  - 큰 자리: 앱 빌드가 이 파일을 three와 함께 doori3d.js 하나로 묶고, 화면이 필요할 때만 불러 mountDoori()
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

export const MOODS = ['idle', 'thinking', 'working', 'asking', 'done', 'sleeping']

const MINT = new THREE.Color('#2fc48d')
const BUTTER = '#ffc928'
const lighten = (c, a) => c.clone().lerp(new THREE.Color('#ffffff'), a)
const darken = (c, a) => c.clone().multiplyScalar(1 - a)

export function createDoori(renderer) {
  const scene = new THREE.Scene()
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

  scene.add(new THREE.HemisphereLight(0xffffff, 0xe9efe9, 0.45))
  const key = new THREE.DirectionalLight(0xffffff, 1.2)
  key.position.set(-3, 5, 6)
  scene.add(key)
  const rimA = new THREE.PointLight(0x7fc6ff, 14, 10)
  rimA.position.set(-3, 1.2, 1.2)
  scene.add(rimA)
  const rimB = new THREE.PointLight(0xffa3c8, 12, 10)
  rimB.position.set(3, -0.6, 1.4)
  scene.add(rimB)

  const root = new THREE.Group()
  scene.add(root)
  const body = new THREE.Group()
  root.add(body)

  // ── 몸 (위는 밝게, 아래는 진하게, 옆면에 살짝 무지개빛)
  const W = 2.0
  const H = 1.95
  const D = 1.6
  const geo = new RoundedBoxGeometry(W, H, D, 10, 0.55)
  const pos = geo.attributes.position
  const nrm = geo.attributes.normal
  const colors = new Float32Array(pos.count * 3)
  const rainbow = ['#5ba8ff', '#a98bff', '#ff8fc0', '#ffc928', '#7ee0b0'].map((c) => new THREE.Color(c))
  const tmp = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) / (H / 2) + 1) / 2
    tmp.copy(t > 0.5 ? lighten(MINT, (t - 0.5) * 0.3) : darken(MINT, (0.5 - t) * 0.5))
    const side = 1 - Math.abs(nrm.getZ(i))
    if (side > 0.25) {
      const a = Math.atan2(nrm.getY(i), nrm.getX(i)) / (Math.PI * 2) + 0.5
      const idx = a * (rainbow.length - 1)
      const c = rainbow[Math.floor(idx)]
        .clone()
        .lerp(rainbow[Math.min(Math.ceil(idx), rainbow.length - 1)], idx % 1)
      tmp.lerp(c, Math.min((side - 0.25) * 0.45, 0.3))
    }
    colors.set([tmp.r, tmp.g, tmp.b], i * 3)
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const shell = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.16,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    iridescence: 0.35,
    iridescenceIOR: 1.35,
    iridescenceThicknessRange: [200, 650],
    envMapIntensity: 0.6,
  })
  body.add(new THREE.Mesh(geo, shell))

  // ── 얼굴
  const face = new THREE.Group()
  face.position.z = D / 2 + 0.005
  body.add(face)
  const ink = new THREE.MeshPhysicalMaterial({ color: '#111214', roughness: 0.2, clearcoat: 1 })
  const white = new THREE.MeshBasicMaterial({ color: '#ffffff' })

  // 뜬 눈 (캡슐 + 반짝임)
  const openEyes = []
  for (const ex of [-0.32, 0.32]) {
    const eye = new THREE.Group()
    const slot = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.2, 10, 24), ink)
    slot.scale.z = 0.45
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.036, 16, 16), white)
    glint.position.set(-0.03, 0.09, 0.05)
    eye.add(slot, glint)
    eye.userData.x = ex
    face.add(eye)
    openEyes.push(eye)
  }
  // 웃는 눈 ^ ^ / 감은 눈 ‿ ‿ : 반원 고리
  const arcEye = (flip) => {
    const g = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.042, 12, 32, Math.PI), ink)
    g.scale.z = 0.5
    if (flip) g.rotation.z = Math.PI
    return g
  }
  const happyEyes = [-0.32, 0.32].map((x) => {
    const e = arcEye(false)
    e.position.set(x, 0.06, 0)
    face.add(e)
    return e
  })
  const sleepEyes = [-0.32, 0.32].map((x) => {
    const e = arcEye(true)
    e.position.set(x, 0.12, 0)
    face.add(e)
    return e
  })
  // 볼 (다 했어요)
  const blushMat = new THREE.MeshBasicMaterial({
    color: '#ffa0b8',
    transparent: true,
    opacity: 0.92,
    toneMapped: false,
  })
  const blush = [-0.56, 0.56].map((x) => {
    const b = new THREE.Mesh(new THREE.CircleGeometry(0.12, 32), blushMat)
    b.scale.y = 0.6
    b.position.set(x, -0.1, 0.004)
    face.add(b)
    return b
  })

  // 열쇠 구멍 입
  const keyMat = new THREE.MeshStandardMaterial({ color: darken(MINT, 0.55), roughness: 0.4 })
  const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.094, 0.094, 0.03, 32), keyMat)
  hole.rotation.x = Math.PI / 2
  hole.position.set(0, -0.35, 0)
  const trap = new THREE.Shape()
  trap.moveTo(-0.052, -0.39)
  trap.lineTo(0.052, -0.39)
  trap.lineTo(0.082, -0.56)
  trap.lineTo(-0.082, -0.56)
  trap.closePath()
  const stem = new THREE.Mesh(new THREE.ExtrudeGeometry(trap, { depth: 0.03, bevelEnabled: false }), keyMat)
  stem.position.z = -0.015
  face.add(hole, stem)

  // ── 발
  const footMat = new THREE.MeshPhysicalMaterial({ color: darken(MINT, 0.12), roughness: 0.25, clearcoat: 1 })
  for (const fx of [-0.42, 0.42]) {
    const foot = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.42, 0.52, 6, 0.19), footMat)
    foot.position.set(fx, -H / 2 - 0.08, 0.15)
    root.add(foot)
  }

  // ── 소품 (몸 밖, 머리 오른쪽 위)
  const glossy = (color) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.2, clearcoat: 1 })
  // 생각 중: 점 세 개
  const dots = new THREE.Group()
  ;[
    [1.0, 1.0, 0.07],
    [1.2, 1.2, 0.095],
    [1.45, 1.42, 0.125],
  ].forEach(([x, y, r]) => {
    const s = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 24), glossy('#a9b7c6'))
    s.position.set(x, y, 0.2)
    dots.add(s)
  })
  root.add(dots)
  // 물어보는 중: 노란 물음표
  const ask = new THREE.Group()
  const hook = new THREE.CatmullRomCurve3(
    [
      [-0.13, 0.13],
      [-0.07, 0.26],
      [0.06, 0.3],
      [0.16, 0.2],
      [0.12, 0.07],
      [0.02, 0.0],
      [0.0, -0.1],
    ].map(([x, y]) => new THREE.Vector3(x, y, 0)),
  )
  const butter = glossy(BUTTER)
  ask.add(new THREE.Mesh(new THREE.TubeGeometry(hook, 48, 0.05, 12, false), butter))
  const qDot = new THREE.Mesh(new THREE.SphereGeometry(0.06, 20, 20), butter)
  qDot.position.y = -0.24
  ask.add(qDot)
  ask.scale.setScalar(1.6)
  ask.position.set(1.12, 1.15, 0.3)
  ask.rotation.z = -0.18
  root.add(ask)
  // 일하는 중: 땀방울
  const sweat = new THREE.Group()
  const drop = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 24), glossy('#7fc6ff'))
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.18, 24), glossy('#7fc6ff'))
  tip.position.y = 0.12
  sweat.add(drop, tip)
  sweat.position.set(1.04, 0.55, 0.45)
  sweat.rotation.z = -0.35
  sweat.scale.setScalar(1.45)
  root.add(sweat)
  // 다 했어요: 반짝 별 두 개
  const starShape = new THREE.Shape()
  for (let i = 0; i < 8; i++) {
    const r = i % 2 ? 0.045 : 0.16
    const a = (i / 8) * Math.PI * 2 + Math.PI / 2
    const fn = i ? 'lineTo' : 'moveTo'
    starShape[fn](Math.cos(a) * r, Math.sin(a) * r)
  }
  const starGeo = new THREE.ExtrudeGeometry(starShape, {
    depth: 0.04,
    bevelEnabled: true,
    bevelSize: 0.02,
    bevelThickness: 0.02,
    bevelSegments: 3,
  })
  const sparks = new THREE.Group()
  ;[
    [1.12, 0.98, 1],
    [-1.12, 0.8, 0.7],
  ].forEach(([x, y, s]) => {
    const m = new THREE.Mesh(starGeo, butter)
    m.position.set(x, y, 0.3)
    m.scale.setScalar(s)
    sparks.add(m)
  })
  root.add(sparks)
  // 자는 중: Z z
  const zShape = new THREE.Shape()
  ;[
    [-0.5, 0.5],
    [0.5, 0.5],
    [0.5, 0.3],
    [-0.15, -0.3],
    [0.5, -0.3],
    [0.5, -0.5],
    [-0.5, -0.5],
    [-0.5, -0.3],
    [0.15, 0.3],
    [-0.5, 0.3],
  ].forEach(([x, y], i) => {
    if (i) zShape.lineTo(x, y)
    else zShape.moveTo(x, y)
  })
  const zGeo = new THREE.ExtrudeGeometry(zShape, {
    depth: 0.18,
    bevelEnabled: true,
    bevelSize: 0.06,
    bevelThickness: 0.06,
    bevelSegments: 3,
  })
  const zs = new THREE.Group()
  ;[
    [1.02, 1.0, 0.2],
    [1.36, 1.36, 0.27],
  ].forEach(([x, y, s]) => {
    const m = new THREE.Mesh(zGeo, glossy('#a98bff'))
    m.position.set(x, y, 0.2)
    m.scale.setScalar(s)
    zs.add(m)
  })
  root.add(zs)

  root.rotation.set(0.04, -0.18, 0)

  let mood = 'idle'
  function setMood(m) {
    mood = MOODS.includes(m) ? m : 'idle'
    const open = !['done', 'sleeping'].includes(mood)
    for (const e of openEyes) e.visible = open
    for (const e of happyEyes) e.visible = mood === 'done'
    for (const e of sleepEyes) e.visible = mood === 'sleeping'
    for (const b of blush) b.visible = mood === 'done'
    dots.visible = mood === 'thinking'
    ask.visible = mood === 'asking'
    sweat.visible = mood === 'working'
    sparks.visible = mood === 'done'
    zs.visible = mood === 'sleeping'
    // 눈 위치·크기: 생각 중엔 위를, 일하는 중엔 아래를 집중해서 본다
    const look = {
      thinking: [-0.05, 0.08, 1, 1],
      working: [0.05, -0.02, 1, 0.66],
      asking: [0, 0.05, 1.16, 1.12],
    }[mood] ?? [0, 0, 1, 1]
    for (const e of openEyes) {
      e.position.set(e.userData.x + look[0], 0.11 + look[1], 0)
      e.scale.set(look[2], look[3] * look[2], 1)
      e.userData.sy = look[3] * look[2]
    }
    body.scale.set(1, 1, 1)
    body.position.set(0, 0, 0)
    root.rotation.set(0.04, mood === 'thinking' ? -0.32 : -0.18, mood === 'sleeping' ? 0.06 : 0)
  }
  setMood('idle')

  /** 움직임 한 칸: 숨쉬기·깜빡임·소품 흔들림 */
  let nextBlink = 2.2
  function animate(t) {
    const breath = mood === 'sleeping' ? 0.9 : mood === 'working' ? 3.2 : 1.4
    body.position.y = Math.sin(t * breath) * (mood === 'sleeping' ? 0.02 : 0.05)
    const sq = mood === 'sleeping' ? 0.02 : 0.008
    body.scale.set(1 + Math.sin(t * breath * 2) * sq, 1 - Math.sin(t * breath * 2) * sq, 1)
    const since = t - nextBlink
    const blink = since > 0 && since < 0.13
    if (since > 0.13) nextBlink = t + 2.2 + Math.random() * 3
    for (const e of openEyes) e.scale.y = blink ? 0.1 : e.userData.sy
    dots.children.forEach((d, i) => {
      d.position.y = [1.0, 1.2, 1.42][i] + Math.sin(t * 2.4 - i * 0.7) * 0.05
    })
    ask.position.y = 1.15 + Math.sin(t * 2) * 0.06
    ask.rotation.z = -0.18 + Math.sin(t * 1.6) * 0.08
    sweat.position.y = 0.55 - ((t * 0.5) % 1) * 0.15
    sparks.children.forEach((s, i) => {
      s.rotation.z = t * (i ? -1.2 : 1)
    })
    zs.children.forEach((z, i) => {
      z.position.y = [1.0, 1.36][i] + Math.sin(t * 1.2 + i) * 0.06
    })
  }

  return { scene, root, setMood, animate, dispose: () => pmrem.dispose() }
}

export function makeCamera(aspect = 1) {
  const camera = new THREE.PerspectiveCamera(26, aspect, 0.1, 100)
  camera.position.set(0.22, 0.12, 7.2)
  camera.lookAt(0.22, 0.12, 0)
  return camera
}

export function makeRenderer(opts = {}) {
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, ...opts })
  r.toneMapping = THREE.NeutralToneMapping
  r.toneMappingExposure = 0.85
  r.outputColorSpace = THREE.SRGBColorSpace
  return r
}

/**
 * 큰 자리에 움직이는 두리를 띄운다. host 안에 캔버스를 넣고, 화면에서 사라지면 멈춘다.
 * 톡 치면 폴짝. 기기에서 '동작 줄이기'를 켜 두면 한 장만 그린다.
 * @param {HTMLElement} host
 * @param {{ mood?: string }} [opts]
 */
export function mountDoori(host, opts = {}) {
  const renderer = makeRenderer()
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  const canvas = renderer.domElement
  canvas.className = 'doori-canvas'
  host.append(canvas)
  const d = createDoori(renderer)
  d.setMood(opts.mood ?? 'idle')
  const camera = makeCamera(1)
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const start = performance.now()
  let hopAt = -10
  let raf = 0
  let visible = true
  let mood = opts.mood ?? 'idle'

  const resize = () => {
    const { width, height } = host.getBoundingClientRect()
    if (!width || !height) return
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }
  const draw = () => {
    const t = (performance.now() - start) / 1000
    d.animate(still ? 0.9 : t)
    const hop = Math.max(0, 1 - (t - hopAt) / 0.6)
    d.root.position.y = Math.sin(hop * Math.PI) * 0.35
    if (!still) d.root.rotation.y = (mood === 'thinking' ? -0.32 : -0.18) + Math.sin(t * 0.5) * 0.06
    renderer.render(d.scene, camera)
  }
  const loop = () => {
    raf = 0
    draw()
    if (!still && visible && host.isConnected) raf = requestAnimationFrame(loop)
  }
  const wake = () => {
    if (!raf && !still) raf = requestAnimationFrame(loop)
  }
  const onTap = () => {
    hopAt = (performance.now() - start) / 1000
    wake()
  }
  canvas.addEventListener('pointerdown', onTap)
  const ro = new ResizeObserver(() => {
    resize()
    draw()
  })
  ro.observe(host)
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting
    if (visible) wake()
  })
  io.observe(host)
  const onVis = () => {
    visible = document.visibilityState === 'visible'
    if (visible) wake()
  }
  document.addEventListener('visibilitychange', onVis)
  resize()
  draw()
  wake()

  return {
    setMood(m) {
      mood = m
      d.setMood(m)
      draw()
    },
    destroy() {
      cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      canvas.removeEventListener('pointerdown', onTap)
      d.dispose()
      renderer.dispose()
      canvas.remove()
    },
  }
}
