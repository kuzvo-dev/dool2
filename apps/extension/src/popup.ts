// The small window shown when the extension icon is clicked: shows whether it is connected to the Dool2 app
import { lang } from './lang.js'
import { popupText } from './locales/ui.js'

const m = popupText(lang)
const stateEl = document.getElementById('state') as HTMLParagraphElement
const detailEl = document.getElementById('detail') as HTMLParagraphElement
const retry = document.getElementById('retry') as HTMLButtonElement
document.documentElement.lang = lang
;(document.getElementById('name') as HTMLElement).textContent = m.name
retry.textContent = m.retry
stateEl.replaceChildren(
  Object.assign(document.createElement('i'), { className: 'dot' }),
  Object.assign(document.createElement('span'), { textContent: m.checking }),
)

type Status = { state: 'connecting' | 'on' | 'off'; detail?: string; connected: boolean }

function show(s: Status) {
  const on = s.connected
  const dot = document.createElement('i')
  dot.className = on ? 'dot ok' : s.state === 'connecting' ? 'dot' : 'dot warn'
  const text = document.createElement('span')
  text.textContent = on ? m.connected : s.state === 'connecting' ? m.connecting : m.notConnected
  stateEl.replaceChildren(dot, text)
  detailEl.textContent = on ? m.connectedNote : m.offNote(s.detail)
  retry.hidden = on
}

async function ask(type: 'status' | 'retry') {
  show((await chrome.runtime.sendMessage({ type })) as Status)
}

retry.addEventListener('click', async () => {
  await ask('retry')
  setTimeout(() => ask('status'), 1500)
})
ask('status')
