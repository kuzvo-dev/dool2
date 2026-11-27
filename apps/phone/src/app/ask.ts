// Phone app: sending a request from the composer, keeping the conversation on the phone, attaching a photo
import type { ConnectRecordMessage } from '@dool2/protocol'
import { lang } from '../lang.js'
import { mainCore } from '../locales/main-a-core.js'
import { saveConv } from '../store.js'
import { connectFor } from './approval-cards.js'
import { chatVars } from './chat.js'
import { coreVars, send, st } from './core.js'
import { openOverlay, render, setTab, shell, shellVars, toast } from './shell.js'

// ── Tasks ──

/** Send a request: show my message right away and send it to the PC */
export function ask(text: string) {
  const photo = st.attach
  const t = text.trim() || (photo ? mainCore(lang).photoDefault : '')
  if (!t || !st.online) return
  chatVars.awayFrom = undefined
  st.pending.push({ id: ++coreVars.pendingSeq, text: t, at: Date.now(), ...(photo ? { photo } : {}) })
  setTimeout(render, 12_500)
  st.draft = ''
  st.attach = undefined
  st.tab = 'chat'
  shellVars.stickToBottom = true
  render()
  void send({ kind: 'ask', text: t, ...(photo ? { image: photo } : {}) })
}

/**
 * Connecting happens in the chat: show my message "Connect X" right away, and the PC leaves a connect card in the chat.
 * Login continues on that card, and progress and results stay in the same chat (no waiting on the connect screen)
 */
export function connectInChat(id: string) {
  const it = st.services?.find((s) => s.card.id === id)
  // Services used by logging in (browser, before an official integration) all connect in the chat. Only phone permissions (device) are turned on from the connect screen
  if (!it || it.card.how === 'device' || it.card.how === 'open') return openOverlay({ kind: 'connect', id })
  if (!st.online) return toast(mainCore(lang).needPcOnline)
  // If the same connect card is already near the end of the chat, go to it instead of stacking a new one
  const near = st.conv.slice(-6).some((m) => {
    if (m.role !== 'tool') return false
    try {
      const rec = JSON.parse(m.text) as ConnectRecordMessage
      return rec.kind === 'connect' && connectFor(rec)?.card.id === id
    } catch {
      return false
    }
  })
  st.connectDetail = undefined
  if (near) return setTab('chat')
  st.pending.push({
    id: ++coreVars.pendingSeq,
    text: mainCore(lang).connectAsk(it.card.name),
    at: Date.now(),
  })
  setTab('chat')
  void send({ kind: 'connect', id, action: 'chat' })
}

let convSaveTimer: ReturnType<typeof setTimeout> | undefined
let convSavedLast = ''
/** Keeps the last 40 conversation lines on the phone (only when changed, batched for 1 second) */
export function keepConv() {
  if (!st.convLoaded) return
  const tail = st.conv.slice(-40)
  const sig = `${tail.length}:${tail.at(-1)?.id ?? ''}`
  if (sig === convSavedLast) return
  clearTimeout(convSaveTimer)
  convSaveTimer = setTimeout(() => {
    convSavedLast = sig
    void saveConv(tail).catch(() => undefined)
  }, 1000)
}

/** Shrinks a photo to a JPEG of at most 1024px and 300KB (so one relay message can carry it) */
async function shrinkPhoto(file: File): Promise<string> {
  const bmp = await createImageBitmap(file)
  for (const [max, q] of [
    [1024, 0.78],
    [900, 0.65],
    [720, 0.55],
  ] as const) {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height))
    const c = document.createElement('canvas')
    c.width = Math.round(bmp.width * scale)
    c.height = Math.round(bmp.height * scale)
    c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height)
    const data = c.toDataURL('image/jpeg', q).split(',')[1] ?? ''
    if (data.length < 300_000) return data
  }
  throw new Error(mainCore(lang).photoTooBig)
}

/** + > Send a photo */
export function pickPhoto() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = async () => {
    const f = input.files?.[0]
    if (!f) return
    try {
      st.attach = await shrinkPhoto(f)
      st.overlay = undefined
      st.tab = 'chat'
      render()
      shell?.textarea.focus()
    } catch (e) {
      toast((e as Error).message)
    }
  }
  input.click()
}
