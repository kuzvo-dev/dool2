// Phone app: the relay connection to the PC (connect, forget, reset), receiving and handling what the PC sends, and the reply stream
import type { DaemonStreamEvent, PcToPhone } from '@dool2/protocol'
import { type Envelope, open, signText } from '@dool2/protocol/e2e'
import { autoApproveSignText, LinkClient, resetSignText } from '@dool2/protocol/link'
import { narrationLine, splitPhoto, toolLabel, toolPlace } from '@dool2/protocol/rich'
import { lang } from '../lang.js'
import { mainCore } from '../locales/main-a-core.js'
import { tReview } from '../locales/review.js'
import { confirmDevice, defaultRelay } from '../native.js'
import type { Shot } from '../remote.js'
import { clear, clearConv, save } from '../store.js'
import { hostOf } from './approval-cards.js'
import { gotThumb } from './cards.js'
import { mark, mSet, send, st, trail } from './core.js'
import { syncApproveKeys } from './decide.js'
import { runAfterConnect } from './ideas.js'
import { activityPager, feedPager, fileChunkWaits, fullItems, libPagers, takeLife } from './lists.js'
import { notify, openPending, syncPush } from './push.js'
import { resyncVars } from './resync.js'
import { openOverlay, remoteUi, render, renderSoon, shellVars, toast } from './shell.js'
import { hello } from './sms.js'
import { isSideThread, onSideStream, openSide } from './threads.js'
import {
  fps,
  frameTimes,
  nextScreen,
  openRemote,
  pollConnect,
  pollWork,
  remoteFrom,
  stepAt,
  stepInfo,
  tabHosts,
  workVars,
} from './work.js'

let heard = false
let silentTimer: ReturnType<typeof setTimeout> | undefined

/** Clears this phone's connection and returns to the start (scan QR) */
/**
 * Reset data: asks twice, checks the phone lock, and sends a request signed with this phone's key. The PC erases only
 * after verifying the signature
 */
export async function resetAll() {
  const s = st.saved
  if (!s) return
  if (!confirm(mainCore(lang).resetAsk)) return
  const services = confirm(mainCore(lang).resetServicesAsk)
  if ((await confirmDevice(mSet.startOver)) === 'cancel') return
  mark(`reset (services ${services ? 'included' : 'kept'})`)
  const at = Date.now()
  const sig = await signText(s.keys.signPriv, resetSignText(at, services))
  toast(mainCore(lang).resetting)
  await send({ kind: 'reset', at, services, sig })
}

/** Auto-approve on or off (ADR 0030). Turning it on asks twice (a dialog and the phone lock); the request is signed */
export async function setAutoApprove(on: boolean) {
  const s = st.saved
  if (!s) return
  if (on) {
    if (!confirm(mSet.autoApproveAsk)) return
    if ((await confirmDevice(mSet.autoApproveDevice)) === 'cancel') return
  }
  mark(`auto-approve ${on ? 'on' : 'off'}`)
  const at = Date.now()
  const sig = await signText(s.keys.signPriv, autoApproveSignText(on, at))
  await send({ kind: 'auto-approve', on, at, sig })
}

export async function forgetPc() {
  st.client?.stop()
  st.client = undefined
  await clear()
  await clearConv().catch(() => undefined)
  st.saved = undefined
  st.key = undefined
  st.online = false
  st.pcSilent = false
  st.conv = []
  st.convLoaded = false
  st.overlay = undefined
  st.screen = { name: 'intro' }
  render()
}

/**
 * A PC that sends its health every half minute and then goes quiet has stopped answering (sleep, stall, network):
 * say so without waiting for the next reconnect. Only once it has sent one (older PCs never do)
 */
const HEALTH_SILENT_MS = 100_000
setInterval(() => {
  if (!st.online || st.pcSilent || st.healthAt === undefined || document.hidden) return
  if (Date.now() - st.healthAt < HEALTH_SILENT_MS) return
  st.pcSilent = true
  mark('pc silent (no health)')
  render()
}, 20_000)

export function connect() {
  const s = st.saved
  if (!s) return
  st.client?.stop()
  st.client = new LinkClient({
    relay: s.relay ?? defaultRelay(),
    role: 'phone',
    keys: s.keys,
    room: s.pcId,
    onEnvelope: (env) => void receive(env),
    onState: (state) => {
      if (st.online !== (state === 'ready')) mark(`relay ${state}`)
      st.online = state === 'ready'
      clearTimeout(silentTimer)
      if (state === 'ready' && st.saved?.paired) {
        // If the PC says nothing within 7 seconds, tell the user (so it does not sit on an empty screen)
        heard = false
        silentTimer = setTimeout(() => {
          if (heard || !st.online) return
          st.pcSilent = true
          render()
        }, 7000)
        hello()
        void send({ kind: 'conversation' })
        void send({ kind: 'connections' })
        void send({ kind: 'life' })
      }
      render()
    },
  })
  st.client.start()
}

async function receive(env: Envelope) {
  const s = st.saved
  if (!s || !st.key || env.from !== s.pcId || env.to !== s.keys.id) return
  let msg: PcToPhone
  try {
    msg = await open<PcToPhone>(st.key, env)
  } catch {
    return
  }
  heard = true
  if (st.pcSilent) st.pcSilent = false
  await handle(msg)
}

/** Everything the PC says, after it was opened (the demo's pretend PC calls this directly) */
export async function handle(msg: PcToPhone) {
  const s = st.saved
  if (!s) return
  markReceived(msg)
  switch (msg.kind) {
    case 'paired':
      s.paired = true
      s.pcName = msg.pcName
      await save(s)
      toast(mainCore(lang).paired)
      st.screen = { name: 'app' }
      // Fetch the same things as on reconnect (so feed, goals and ideas do not look empty)
      void send({ kind: 'conversation' })
      void send({ kind: 'connections' })
      void send({ kind: 'life' })
      break
    case 'pair-rejected':
      if (st.screen.name === 'pairing') st.screen = { ...st.screen, rejected: true }
      await clear()
      st.saved = undefined
      break
    case 'state':
      st.pc = msg
      // If the PC name was changed on the PC or another phone, follow it
      if (msg.pcName && msg.pcName !== s.pcName) {
        s.pcName = msg.pcName
        await save(s)
      }
      for (const a of msg.approvals) if (!st.approvals.has(a.id)) st.approvals.set(a.id, a)
      for (const l of msg.logins ?? []) st.logins.set(l.id, l)
      // The pending logins the PC sent are the whole list: one not in it has finished on the PC (daemon restarted, timed out) or is gone
      // (a Kurly login card used to stay under "waiting for me" even after connecting)
      for (const l of st.logins.values())
        if (l.status === 'pending' && !(msg.logins ?? []).some((x) => x.id === l.id))
          st.logins.set(l.id, { ...l, status: 'expired' })
      for (const q of msg.infos ?? []) st.infos.set(q.id, q)
      for (const id of st.infos.keys()) if (!(msg.infos ?? []).some((q) => q.id === id)) st.infos.delete(id)
      st.connecting = new Set(msg.connecting ?? [])
      // If the app was reopened mid-work: get the tab Dool2 is looking at and keep showing the working screen
      if (msg.activeTab !== undefined && st.work.tabId === undefined)
        st.work = { ...st.work, tabId: msg.activeTab }
      void syncPush()
      void syncApproveKeys()
      openPending()
      break
    case 'conversation':
      if (msg.before) {
        const have = new Set(st.conv.map((m) => m.id))
        st.conv = [...msg.state.messages.filter((m) => !have.has(m.id)), ...st.conv]
      } else {
        st.conv = msg.state.messages
        st.convLoaded = true
        shellVars.stickToBottom = true
      }
      st.hasMore = msg.state.hasMore
      if (!msg.before) st.checking = msg.state.checking === true
      if (!msg.before && msg.state.tasks) st.tasks = new Map(msg.state.tasks.map((t) => [t.id, t]))
      st.busy = msg.state.busy
      st.queued = msg.state.queued
      // Drop from "sending" any message already in the re-fetched record or already queued (otherwise it shows twice)
      if (!msg.before) {
        const mine = new Set(
          msg.state.messages.filter((m) => m.role === 'user').map((m) => splitPhoto(m.text).text),
        )
        st.pending = st.pending.filter((p) => !mine.has(p.text) && !msg.state.queued.includes(p.text))
      }
      // If the re-fetched record is finished, clear a "replying" state left by a missed end signal
      if (!msg.before && !msg.state.busy) {
        st.live = ''
        st.steps = []
      }
      break
    // A task changed (ADR 0038): its card redraws in its place in the chat. Through the chat list (its signature
    // carries the task's state), not by swapping the element: a swapped-in card lost the list's key, so the next
    // redraw added the card again and the old one stayed
    case 'task':
      st.tasks.set(msg.task.id, msg.task)
      break
    case 'health':
      st.health = msg.health
      st.healthAt = Date.now()
      break
    case 'conversation-status':
      st.busy = msg.busy
      st.checking = msg.checking === true
      if (st.busy) st.workFrom ??= Date.now()
      else st.workFrom = undefined
      st.queued = msg.queued
      // A message that moved to the queue is dropped from "sending"
      st.pending = st.pending.filter((p) => !msg.queued.includes(p.text))
      if (!msg.busy) {
        st.live = ''
        st.steps = []
      }
      break
    case 'stream':
      // Progress of a side conversation goes to its own screen, the rest to the main chat
      if (isSideThread(msg.threadId)) {
        onSideStream(msg.threadId, msg.event)
        if (st.screen.name !== 'side') return
        break
      }
      onStream(msg.event)
      break
    case 'approval':
      st.approvals.set(msg.approval.id, msg.approval)
      if (msg.approval.status === 'pending')
        notify(mainCore(lang).approvalWaiting, msg.approval.what, `approval-${msg.approval.id}`)
      break
    case 'thumb':
      gotThumb(msg.url, msg.data)
      break
    case 'vault':
      st.vault = msg.entries
      st.vaultEdit = undefined
      if (msg.message) toast(msg.message)
      break
    case 'vault-secret': {
      st.vaultShown = { id: msg.id, username: msg.username, password: msg.password }
      const id = msg.id
      setTimeout(() => {
        if (st.vaultShown?.id === id) {
          st.vaultShown = undefined
          render()
        }
      }, 30_000)
      break
    }
    case 'profile':
      st.profile = {
        have: msg.have,
        missing: msg.missing,
        payChoices: msg.payChoices,
        ...(msg.payMethods ? { payMethods: msg.payMethods } : {}),
      }
      if (msg.message) toast(msg.message)
      break
    case 'answer-reported':
      toast(msg.ok ? tReview.reportSent(msg.id) : tReview.reportFailed(msg.message))
      break
    case 'reset-done': {
      toast(msg.message)
      if (!msg.ok) break
      // Also clear the conversation pieces and recent log kept on this phone, and relaunch as if the app was opened for the first time (PC link and theme stay)
      await clearConv().catch(() => undefined)
      trail.splice(0)
      setTimeout(() => location.reload(), 1200)
      break
    }
    case 'decided': {
      st.decided.set(msg.id, { ok: msg.ok, message: msg.message })
      const a = st.approvals.get(msg.id)
      if (a && msg.ok) st.approvals.set(msg.id, { ...a, status: a.status === 'pending' ? 'done' : a.status })
      // On success the card changes right away, so no toast bar is shown
      if (!msg.ok) toast(msg.message)
      void send({ kind: 'approval', id: msg.id })
      break
    }
    case 'info-request':
      // What the screen asks for while connecting: open the input screen right away (no need to find the PC screen and type there)
      st.infos.set(msg.request.id, msg.request)
      openOverlay({ kind: 'info', id: msg.request.id })
      break
    case 'info-done':
      st.infos.delete(msg.id)
      if (st.overlay?.kind === 'info' && st.overlay.id === msg.id) st.overlay = undefined
      break
    case 'login-request':
      st.logins.set(msg.request.id, msg.request)
      // An account Dool2 asked for while connecting a service (Kakao and so on): open the input screen right away
      if (msg.request.connect) openOverlay({ kind: 'login', id: msg.request.id })
      notify(
        mainCore(lang).loginNeeded,
        mainCore(lang).loginNeededBody(msg.request.site),
        `login-${msg.request.id}`,
      )
      break
    case 'login-done': {
      const l = st.logins.get(msg.id)
      if (msg.ok && l) st.logins.set(msg.id, { ...l, status: 'saved' })
      if (st.loginDraft.id === msg.id) {
        st.loginDraft.busy = false
        st.loginDraft.error = msg.ok ? undefined : msg.message
        if (msg.ok && st.overlay?.kind === 'login') st.overlay = undefined
      }
      toast(msg.message)
      break
    }
    case 'form': {
      if (remoteUi?.tabId === msg.tabId) remoteUi.setForm(msg.form, msg.error)
      return
    }
    case 'screen': {
      const live =
        st.screen.name !== 'remote' && msg.shot
          ? [...st.connectLive.values()].find((l) => l.tabId === msg.tabId)
          : undefined
      if (live && msg.shot) {
        // Login screen inside a connect card: only swap the image
        const first = !live.shot
        live.shot = msg.shot
        const img = document.querySelector<HTMLImageElement>(`.connect-shot[data-tab="${msg.tabId}"]`)
        if (img) img.src = `data:image/jpeg;base64,${msg.shot}`
        if (first) renderSoon()
        return
      }
      if (st.screen.name !== 'remote' && msg.tabId === st.work.tabId && msg.shot) {
        // Working screen in the chat: only swap the image
        const first = !st.work.shot
        st.work = { ...st.work, shot: msg.shot, ...(msg.url ? { url: msg.url } : {}) }
        const shotHost = msg.url ? hostOf(msg.url) : ''
        if (shotHost) tabHosts.set(msg.tabId, shotHost)
        for (const img of document.querySelectorAll<HTMLImageElement>('.work-shot, .work-thumb'))
          img.src = `data:image/jpeg;base64,${msg.shot}`
        if (first) render()
        return
      }
      if (st.screen.name !== 'remote' || st.screen.tabId !== msg.tabId) return
      const hadShot = !!st.screenShot?.shot
      st.screenShot = { tabId: msg.tabId, ...(msg.error ? { error: msg.error } : {}), ...pick(msg) }
      if (msg.error) break
      frameTimes.push(performance.now())
      nextScreen(msg.tabId)
      // Live screen: only swap the image (the whole screen is not redrawn, so it does not flicker)
      // The remote screen is built once, and only its image and info are swapped
      if (remoteUi?.tabId === msg.tabId && hadShot) {
        remoteUi.update(st.screenShot, fps())
        return
      }
      break
    }
    case 'connections': {
      st.services = msg.services
      // Even when a person or Dool2 finished the login on the screen and it connected, send the postponed request (start right after connecting)
      if (st.afterConnect && msg.services.some((s) => s.card.id === st.afterConnect?.id && s.connectedAt))
        runAfterConnect(st.afterConnect.id)
      // If the PC confirms the login while logging in on the remote screen, go back to that service
      const v = st.screen
      // Whether opened from a connect card or handed over by Dool2 (the same login tab): close it once that service is connected.
      // Left open, the site's first screen after login (a search box and so on) would be drawn as a "field needed" (measured on 11st)
      const ownerOf = (tabId: number) =>
        [...st.connectTabs.entries()].find(([, t]) => t === tabId)?.[0] ??
        [...st.connectFails.entries()].find(([, f]) => f.tabId === tabId)?.[0]
      const remoteFor = v.name === 'remote' ? (v.connectId ?? ownerOf(v.tabId)) : undefined
      if (v.name === 'remote' && remoteFor) {
        const done = msg.services.find((x) => x.card.id === remoteFor && x.connectedAt)
        if (done) {
          // Go back to the chat: the connect card turns to "connected" and the follow-up work shows there
          // (to that service's screen only if it started from the connect screen)
          st.screen = { name: 'app' }
          st.tab = remoteFrom === 'connect' ? 'connect' : 'chat'
          if (st.tab === 'connect') st.connectDetail = done.card.id
          else shellVars.stickToBottom = true
          toast(mainCore(lang).serviceConnected(done.card.name))
          runAfterConnect(done.card.id)
        }
      }
      for (const x of msg.services)
        if (x.connectedAt) {
          st.connectFails.delete(x.card.id)
          st.needCreds.delete(x.card.id)
        }
      break
    }
    case 'life':
      takeLife(msg.state)
      break
    case 'life-page':
      // Next page of the request list (without before, fetch the first page again)
      if (msg.list === 'library') libPagers[msg.tab === 'files' ? 'files' : 'made'].take(msg.before, msg)
      else (msg.kinds?.length ? activityPager : feedPager).take(msg.before, msg)
      break
    case 'life-item':
      if (msg.item) fullItems.set(msg.id, msg.item)
      break
    case 'file-chunk':
      fileChunkWaits.get(`${msg.id}:${msg.offset}`)?.(msg)
      break
    case 'work-tab': {
      // Dool2 started working on this tab (browser tool or service tool): if it is replying, show that screen in the chat.
      // It used to open only when the tool name was browser_, so the screen did not show when working with service tools
      const fresh = msg.tabId !== st.work.tabId
      // If it is a new tab of the site just opened, remember that site for the tab
      if (workVars.openedHost && !tabHosts.has(msg.tabId)) {
        tabHosts.set(msg.tabId, workVars.openedHost)
        workVars.openedHost = undefined
      }
      st.work = {
        ...st.work,
        tabId: msg.tabId,
        web: st.work.web || st.busy,
        ...(fresh ? { shot: undefined, url: undefined } : {}),
      }
      pollWork()
      renderSoon()
      return
    }
    case 'connect-status':
      st.connecting = new Set(msg.connecting)
      // Starting again clears the last failure
      for (const id of msg.connecting) st.connectFails.delete(id)
      for (const id of st.connectSteps.keys()) if (!st.connecting.has(id)) st.connectSteps.delete(id)
      for (const id of st.connectLive.keys()) if (!st.connecting.has(id)) st.connectLive.delete(id)
      break
    case 'connect-progress':
      st.connectSteps.set(msg.id, msg.steps)
      if (msg.tabId !== undefined && st.connectLive.get(msg.id)?.tabId !== msg.tabId) {
        st.connectLive.set(msg.id, { tabId: msg.tabId })
        pollConnect()
      }
      break
    case 'connect-result': {
      st.connecting.delete(msg.id)
      st.connectLive.delete(msg.id)
      // Not a failure: the ID and password are needed (Chrome is not signed in, or another account was chosen).
      // The card's button opens the entry from now on (no second look)
      if (msg.reason === 'credentials') {
        st.connectFails.delete(msg.id)
        st.needCreds.add(msg.id)
        if (st.screen.name === 'app' && st.tab === 'chat') openOverlay({ kind: 'connect', id: msg.id })
        break
      }
      const d = st.loginDraft
      if (d.id === `connect:${msg.id}`) {
        d.busy = false
        d.error = msg.ok || msg.human ? undefined : msg.message
      }
      if (msg.tabId !== undefined) st.connectTabs.set(msg.id, msg.tabId)
      if (msg.ok) {
        st.connectFails.delete(msg.id)
        // Turn the card to "connected" even before the connection list arrives (so it does not briefly look unconnected)
        const it = st.services?.find((x) => x.card.id === msg.id)
        if (it && !it.connectedAt) it.connectedAt = new Date().toISOString()
      } else
        st.connectFails.set(msg.id, {
          reason: msg.reason ?? (msg.human ? 'human' : 'unknown'),
          message: msg.message,
          ...(msg.tabId !== undefined ? { tabId: msg.tabId } : {}),
          // If Dool2 took over, from then on (so the moment before it starts replying also reads as "carrying on")
          ...(msg.agent ? { agent: true, at: Date.now() } : {}),
        })
      if (msg.ok) {
        st.connectTabs.delete(msg.id)
        if (st.overlay?.kind === 'connect') st.overlay = undefined
        // If the chat is on screen, the card turning to "connected" is enough (do not say the same thing twice)
        if (st.tab !== 'chat' || st.screen.name !== 'app') toast(msg.message)
        runAfterConnect(msg.id)
      } else if (st.tab !== 'chat' || st.screen.name !== 'app') {
        // Do not switch screens on our own: only notify. If it is the person's turn, tapping the toast opens that screen
        const tab = msg.tabId
        if (tab !== undefined && msg.reason === 'human')
          toast(mainCore(lang).tapToOpen(msg.message), () => openRemote(tab, msg.id))
        else toast(msg.message)
      }
      break
    }
    case 'connect-opened':
      st.opening = undefined
      openRemote(msg.tabId, msg.id)
      return
    case 'error':
      st.opening = undefined
      st.sideWanted = false
      toast(msg.message)
      break
    case 'thread': {
      const t = msg.thread
      if (st.sideWanted && t.side && !msg.messages.length) {
        st.sideWanted = false
        openSide(t.id, t.title)
      }
      if (st.side?.id === t.id) {
        st.side.title = t.title
        st.side.messages = msg.messages
        st.side.busy = Boolean(t.busy)
      }
      break
    }
  }
  renderSoon()
}

/** One line per received signal (kind only, no content; streamed text and screen images are not logged) */
function markReceived(msg: PcToPhone) {
  if (msg.kind === 'screen' || msg.kind === 'form') return
  if (msg.kind === 'stream') {
    const ev = msg.event
    if (ev.type === 'agent') {
      if (ev.event.type === 'tool') mark(`received tool ${ev.event.name}`)
      return
    }
    return mark(`received stream:${ev.type}${ev.type === 'saved' ? `:${ev.message.role}` : ''}`)
  }
  if (msg.kind === 'connect-result')
    return mark(
      `received connect-result ${msg.id} ${msg.ok ? 'ok' : (msg.reason ?? 'fail')}${msg.agent ? ' taken-over' : ''}`,
    )
  if (msg.kind === 'connect-progress')
    return mark(`received connect-progress ${msg.id} ${msg.steps.length} steps`)
  if (msg.kind === 'connect-status')
    return mark(`received connect-status ${msg.connecting.join(',') || 'none'}`)
  if (msg.kind === 'conversation-status')
    return mark(`received conversation-status ${msg.busy ? 'replying' : 'idle'}`)
  if (msg.kind === 'error') return mark(`received error ${msg.message}`)
  mark(`received ${msg.kind}`)
}

function onStream(ev: DaemonStreamEvent) {
  resyncVars.lastStreamAt = Date.now()
  if (ev.type === 'saved') {
    const m = ev.message
    if (!st.conv.some((x) => x.id === m.id)) st.conv = [...st.conv, m]
    if (m.role === 'user') {
      const i = st.pending.findIndex((p) => p.text === splitPhoto(m.text).text)
      if (i >= 0) st.pending.splice(i, 1)
    }
    if (m.role === 'assistant' || (m.role === 'tool' && m.text.includes('"kind":"work"'))) {
      st.live = ''
      st.steps = []
    }
  } else if (ev.type === 'agent') {
    st.busy = true
    st.workFrom ??= Date.now()
    if (ev.event.type === 'text') st.live += ev.event.delta
    else if (ev.event.type === 'tool') {
      // When work on the web starts, show that screen in the chat
      // (Service tools announce their tab with work-tab when the daemon opens it. Using another tool briefly does not turn the view off)
      if (/browser_/.test(ev.event.name) && !st.work.web) {
        st.work = { ...st.work, web: true }
        pollWork()
      }
      // What is said before a tool is not a reply but the current action. Keep that single line as a step and clear the bubble
      const act = mainCore(lang).doing(ev.event.title ?? toolLabel(ev.event.name, lang))
      const label = narrationLine(st.live, lang) ?? act
      st.live = ''
      // Where it worked: the opened address, or for web tools without one, the site of the screen being viewed
      const tabId = (ev.event.input as { tabId?: unknown } | undefined)?.tabId
      const shown = st.work.url && tabId === st.work.tabId ? hostOf(st.work.url) : ''
      const here = (typeof tabId === 'number' ? tabHosts.get(tabId) : undefined) || shown || workVars.workHost
      const place = toolPlace(ev.event.name, ev.event.input, here)
      if (/browser_open$/.test(ev.event.name) && place) {
        workVars.workHost = place
        workVars.openedHost = place
      }
      if (/browser_navigate$/.test(ev.event.name) && place) {
        workVars.workHost = place
        if (typeof tabId === 'number') tabHosts.set(tabId, place)
      }
      const n = st.steps.length
      if (st.steps.at(-1) !== label || stepInfo[n - 1]?.place !== place) {
        if (n === 0) {
          stepAt.length = 0
          stepInfo.length = 0
          workVars.workAllSteps = false
        }
        st.steps = [...st.steps, label]
        stepAt[n] = Date.now()
        stepInfo[n] = {
          act,
          ...(place ? { place } : {}),
          ...(ev.event.detail ? { detail: ev.event.detail } : {}),
        }
      } else if (ev.event.detail) {
        // The same line again: what it did adds up (the "how it worked" sheet shows it)
        const cur = stepInfo[n - 1]
        if (cur) cur.detail = [...(cur.detail ?? []), ...ev.event.detail].slice(-6)
      }
    }
  } else if (ev.type === 'end') {
    st.live = ''
    st.steps = []
    workVars.workHost = undefined
    workVars.openedHost = undefined
    tabHosts.clear()
    st.work = { ...st.work, web: false, shot: undefined }
    hello()
  }
}

function pick(m: Omit<Shot, 'tabId'>) {
  return {
    ...(m.shot ? { shot: m.shot } : {}),
    ...(m.url ? { url: m.url } : {}),
    ...(m.title ? { title: m.title } : {}),
    ...(m.fields ? { fields: m.fields } : {}),
    ...(m.actions ? { actions: m.actions } : {}),
    ...(m.focus !== undefined ? { focus: m.focus } : {}),
  }
}
