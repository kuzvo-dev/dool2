// 확장 아이콘을 누르면 뜨는 작은 창: 두리 앱과 연결됐는지 보여 준다
const stateEl = document.getElementById('state') as HTMLParagraphElement
const detailEl = document.getElementById('detail') as HTMLParagraphElement
const retry = document.getElementById('retry') as HTMLButtonElement

type Status = { state: 'connecting' | 'on' | 'off'; detail?: string; connected: boolean }

function show(s: Status) {
  const on = s.connected
  const dot = document.createElement('i')
  dot.className = on ? 'dot ok' : s.state === 'connecting' ? 'dot' : 'dot warn'
  const text = document.createElement('span')
  text.textContent = on
    ? '두리 앱과 연결됐어요'
    : s.state === 'connecting'
      ? '연결하는 중…'
      : '연결되지 않았어요'
  stateEl.replaceChildren(dot, text)
  detailEl.textContent = on
    ? '두리가 일할 때는 초록색 "두리" 탭 그룹에서만 움직여요.'
    : `${s.detail ?? '두리 앱이 꺼져 있어요'}. 두리 앱을 켜면 30초 안에 다시 연결돼요.`
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
