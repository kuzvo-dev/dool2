// 3D Dool2: soft square body + power-outlet face (two eyes + keyhole mouth) + two short feet. Same shape as on the landing page.
// The 6 moods (idle, thinking, working, asking, done, sleeping) change the eyes and a prop beside the head.
//
// Used in two ways:
//  - Small spots: doori/*.webp (still images pre-rendered from this file, re-render with doori-render.html)
//  - Large spots: the app build bundles this file with three into one doori3d.js, and screens load it only when needed and call mountDoori()
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

  // ── Body (lighter on top, darker below, a slight iridescence on the sides)
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

  // ── Face
  const face = new THREE.Group()
  face.position.z = D / 2 + 0.005
  body.add(face)
  const ink = new THREE.MeshPhysicalMaterial({ color: '#111214', roughness: 0.2, clearcoat: 1 })
  const white = new THREE.MeshBasicMaterial({ color: '#ffffff' })

  // Open eyes (capsule + sparkle)
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
  // Smiling eyes ^ ^ / closed eyes ‿ ‿ : half-ring arcs
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
  // Cheeks (done)
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

  // Keyhole mouth
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

  // ── Feet
  const footMat = new THREE.MeshPhysicalMaterial({ color: darken(MINT, 0.12), roughness: 0.25, clearcoat: 1 })
  for (const fx of [-0.42, 0.42]) {
    const foot = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.42, 0.52, 6, 0.19), footMat)
    foot.position.set(fx, -H / 2 - 0.08, 0.15)
    root.add(foot)
  }

  // ── Props (outside the body, top right of the head)
  const glossy = (color) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.2, clearcoat: 1 })
  // Thinking: three dots
  const dots = new THREE.Group()
  ;[
    [0.9, 0.92, 0.07],
    [1.06, 1.08, 0.09],
    [1.24, 1.24, 0.115],
  ].forEach(([x, y, r]) => {
    const s = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 24), glossy('#a9b7c6'))
    s.position.set(x, y, 0.2)
    dots.add(s)
  })
  root.add(dots)
  // Asking: yellow question mark
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
  ask.scale.setScalar(1.35)
  ask.position.set(1.0, 0.95, 0.3)
  ask.rotation.z = -0.18
  root.add(ask)
  // Working: sweat drop
  const sweat = new THREE.Group()
  const drop = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 24), glossy('#7fc6ff'))
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.18, 24), glossy('#7fc6ff'))
  tip.position.y = 0.12
  sweat.add(drop, tip)
  sweat.position.set(0.98, 0.5, 0.45)
  sweat.rotation.z = -0.35
  sweat.scale.setScalar(1.45)
  root.add(sweat)
  // Done: two sparkling stars
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
    [1.02, 0.95, 1],
    [-1.02, 0.78, 0.7],
  ].forEach(([x, y, s]) => {
    const m = new THREE.Mesh(starGeo, butter)
    m.position.set(x, y, 0.3)
    m.scale.setScalar(s)
    sparks.add(m)
  })
  root.add(sparks)
  // Sleeping: Z z
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
    [0.95, 0.94, 0.18],
    [1.2, 1.18, 0.24],
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
    // Eye position and size: looks up while thinking, focuses down while working
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

  /** One animation step: breathing, blinking, prop wobble */
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
      d.position.y = [0.92, 1.08, 1.24][i] + Math.sin(t * 2.4 - i * 0.7) * 0.05
    })
    ask.position.y = 0.95 + Math.sin(t * 2) * 0.06
    ask.rotation.z = -0.18 + Math.sin(t * 1.6) * 0.08
    sweat.position.y = 0.5 - ((t * 0.5) % 1) * 0.15
    sparks.children.forEach((s, i) => {
      s.rotation.z = t * (i ? -1.2 : 1)
    })
    zs.children.forEach((z, i) => {
      z.position.y = [0.94, 1.18][i] + Math.sin(t * 1.2 + i) * 0.06
    })
  }

  return { scene, root, setMood, animate, dispose: () => pmrem.dispose() }
}

export function makeCamera(aspect = 1) {
  const camera = new THREE.PerspectiveCamera(26, aspect, 0.1, 100)
  // Body in the exact center of the image (the prop sits at the top right corner of the head, inside the frame)
  camera.position.set(0, 0, 7.3)
  camera.lookAt(0, 0, 0)
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
 * Shows an animated Dool2 in a large spot. Puts a canvas inside host and pauses when it leaves the screen.
 * A tap makes it hop. With "reduce motion" on the device, it draws a single frame.
 * @param {HTMLElement} host
 * @param {{ mood?: string }} [opts]
 */
export function mountDoori(host, opts = {}) {
  const renderer = makeRenderer()
  // The canvas is small, so 1.5x is enough even on Retina (2x means 1.8x the pixels to draw)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
  const canvas = renderer.domElement
  canvas.className = 'doori-canvas'
  host.append(canvas)
  const d = createDoori(renderer)
  d.setMood(opts.mood ?? 'idle')
  const camera = makeCamera(1)
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const start = performance.now()
  let hopAt = -10
  let moodAt = 0
  let raf = 0
  let last = 0
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
  // Always drawing 60-120 fps uses over 50% GPU/CPU (measured, three Dool2s). So
  // - full speed for 1 second after a hop, mood change or hover
  // - 15 fps while working or thinking so the motion shows (6 fps when the window is in the background)
  // - when idle, stop after 6 seconds and keep the last frame. Touching it again resumes
  const busyMood = () => mood === 'working' || mood === 'thinking'
  const loop = (now = performance.now()) => {
    raf = 0
    const t = (now - start) / 1000
    const since = Math.min(t - hopAt, t - moodAt)
    if (!busyMood() && since > 6) return
    const fps = since < 1 ? 0 : document.hasFocus() ? 15 : 6
    if (!fps || now - last >= 1000 / fps - 2) {
      last = now
      draw()
    }
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
  const onHover = () => {
    moodAt = (performance.now() - start) / 1000
    wake()
  }
  canvas.addEventListener('pointerenter', onHover)
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
      moodAt = (performance.now() - start) / 1000
      d.setMood(m)
      draw()
      wake()
    },
    destroy() {
      cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      canvas.removeEventListener('pointerdown', onTap)
      canvas.removeEventListener('pointerenter', onHover)
      d.dispose()
      renderer.dispose()
      // Release the WebGL context right away (otherwise it holds GPU memory until GC)
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}
