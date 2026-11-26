// Phone app: pairing with a PC and the screens before connecting (intro, unsupported, pairing code)
import type { PairInvite, PhoneToPc } from '@dool2/protocol'
import { fromB64u, generateDevice, LINK_VERSION, linkKey, pairCode, seal } from '@dool2/protocol/e2e'
import type { LinkClient } from '@dool2/protocol/link'
import { h, liveDoori } from '../dom.js'
import { mdSide } from '../locales/main-d-side.js'
import { inviteFrom, isNative, scanQr } from '../native.js'
import { type Saved, save } from '../store.js'
import { type Screen, st, tShell } from './core.js'
import { connect } from './link.js'
import { render, setTab, toast } from './shell.js'

// ── Pairing ──

export async function startPairing(raw: string) {
  let invite: PairInvite
  try {
    invite = JSON.parse(new TextDecoder().decode(fromB64u(raw))) as PairInvite
  } catch {
    toast(tShell.qrInvalid)
    return
  }
  // If the invite is from the PC we are already connected to, keep the current connection (same link opened again)
  if (st.saved?.paired && st.saved.pcId === invite.pc) {
    history.replaceState(null, '', location.pathname)
    toast(tShell.alreadyPaired(st.saved.pcName ?? 'PC'))
    return
  }
  history.replaceState(null, '', location.pathname)
  st.client?.stop()
  st.client = undefined
  st.online = false
  st.conv = []
  st.pending = []
  st.approvals.clear()
  st.decided.clear()
  st.pc = undefined
  const keys = await generateDevice(false)
  const saved: Saved = {
    pcId: invite.pc,
    pcBoxPub: invite.k,
    pcName: invite.n,
    keys,
    paired: false,
    seq: 0,
    ...(typeof invite.r === 'string' && /^https?:\/\//.test(invite.r) ? { relay: invite.r } : {}),
  }
  await save(saved)
  st.saved = saved
  st.key = await linkKey(keys.boxPriv, invite.k, [keys.id, invite.pc])
  const code = await pairCode(keys.boxPriv, invite.k)
  st.screen = { name: 'pairing', code, pcName: invite.n }
  render()
  connect()
  // Pairing request: carry this phone's X25519 public key in the header so the PC can derive the key
  saved.seq += 1
  await save(saved)
  const body: PhoneToPc = { kind: 'pair', secret: invite.s, signPub: keys.signPub, name: deviceName() }
  ;(st.client as LinkClient | undefined)?.send({
    ...(await seal(
      st.key,
      { v: LINK_VERSION, from: keys.id, to: invite.pc, kind: 'pair', seq: saved.seq, pub: keys.boxPub },
      body,
    )),
  })
}

function deviceName() {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return tShell.devIphone
  if (/iPad/.test(ua)) return tShell.devIpad
  if (/Android/.test(ua)) return tShell.devAndroid
  return tShell.devPhone
}

// ── Screens before connecting ──

export function introView() {
  return h(
    'section',
    { class: 'center-page' },
    liveDoori('intro', '', 120),
    h('h1', { class: 'display-s', text: mdSide.name }),
    h('p', { class: 'psub', text: mdSide.introSub }),
    h(
      'ol',
      { class: 'steps' },
      h('li', { text: mdSide.step1 }),
      h('li', { text: mdSide.step2 }),
      h('li', { text: isNative() ? mdSide.step3Native : mdSide.step3Web }),
    ),
    isNative() ? h('button', { class: 'btn', text: mdSide.scanQr, onclick: () => void scanInvite() }) : null,
    h('p', { class: 'meta', text: mdSide.encrypted }),
  )
}

/** App: scan the connection QR on the PC screen to start connecting */
async function scanInvite() {
  try {
    const text = await scanQr()
    if (!text) return
    const invite = inviteFrom(text)
    if (!invite) return toast(mdSide.notDoolQr)
    await startPairing(invite)
  } catch (e) {
    toast((e as Error).message || mdSide.scanFailed)
  }
}

/** Android back: closes the open sheet, then a separate chat or remote screen, then returns to the chat tab. Returns false when nothing is left to close */
export function goBack(): boolean {
  if (st.overlay) {
    st.overlay = undefined
    render()
    return true
  }
  if (st.screen.name === 'remote' || st.screen.name === 'side') {
    st.screen = { name: 'app' }
    render()
    return true
  }
  if (st.screen.name === 'app' && st.tab !== 'chat') {
    setTab('chat')
    return true
  }
  return false
}

export function unsupportedView() {
  return h(
    'section',
    { class: 'center-page' },
    liveDoori('center', 'asking', 104),
    ...(isNative()
      ? [
          // The app's screens are drawn by the phone's WebView. Encryption (X25519, Ed25519) works on WebView 137 and later
          h('h1', { class: 'title-2', text: mdSide.updateTitle }),
          h('p', {
            class: 'psub',
            text: mdSide.updateText,
          }),
          h('button', {
            class: 'btn',
            text: mdSide.updateBtn,
            onclick: () => {
              location.href = 'https://play.google.com/store/apps/details?id=com.google.android.webview'
            },
          }),
        ]
      : [
          h('h1', { class: 'title-2', text: mdSide.browserTitle }),
          h('p', {
            class: 'psub',
            text: mdSide.browserText,
          }),
        ]),
  )
}

export function pairingView(v: Extract<Screen, { name: 'pairing' }>) {
  if (v.rejected)
    return h(
      'section',
      { class: 'center-page' },
      liveDoori('center', 'asking', 104),
      h('h1', { class: 'title-2', text: mdSide.rejectedTitle }),
      h('p', { class: 'psub', text: mdSide.rejectedText }),
    )
  return h(
    'section',
    { class: 'center-page' },
    liveDoori('center', 'thinking', 104),
    h('h1', { class: 'title-2', text: mdSide.connectTo(v.pcName) }),
    h('p', { class: 'psub', text: mdSide.seeNumber }),
    h('p', { class: 'pair-code mono', text: v.code }),
    h('p', {
      class: 'meta',
      text: mdSide.pairHint,
    }),
  )
}
