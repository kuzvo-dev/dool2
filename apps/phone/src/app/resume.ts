// Phone app: what the person just answered shows at once. A task waiting for them flips to "carrying on" the moment
// they enter a code, approve or finish a check, instead of waiting 2-3 s for the PC's next update (user 11-27). If the
// PC says nothing within 10 s, it goes back to waiting
import type { TaskView } from '@dool2/protocol'
import { lang } from '../lang.js'
import { mainWork } from '../locales/main-a-work.js'
import { st } from './core.js'
import { render } from './shell.js'

const BACK_AFTER_MS = 10_000

/** After the person answered a card: tasks waiting for them show as carrying on (only when no other card is left) */
export function resumeTasks() {
  const left =
    [...st.approvals.values()].some((a) => a.status === 'pending' && !st.decided.has(a.id)) ||
    [...st.logins.values()].some((l) => l.status === 'pending') ||
    [...st.infos.values()].some((q) => q.status === 'pending')
  if (left) return
  for (const [id, v] of st.tasks) {
    if (v.status !== 'needs-you') continue
    const now: TaskView = { ...v, status: 'working', now: mainWork(lang).resuming }
    st.tasks.set(id, now)
    setTimeout(() => {
      // Still the phone's own guess (the PC sent nothing newer): back to what the PC last said
      if (st.tasks.get(id) !== now) return
      st.tasks.set(id, v)
      render()
    }, BACK_AFTER_MS)
  }
  render()
}
