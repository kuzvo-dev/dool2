// Task session copy people see (ADR 0038): the first line of a task's own chat, notes passed on, notifications.
// Korean is the reference copy; English has the same keys. Text for the AI stays English in tasks.ts.
import { messages } from '@dool2/i18n'

export const TASKS_TEXT = messages({
  ko: {
    /** The first line of the task's own chat (its detail screen) */
    briefShown: (title: string) => `${title}, 맡았어요.`,
    /** A note passed on while the task waited */
    noteShown: (note: string) => `"${note}" 전해 받았어요.`,
    doneTitle: (title: string) => `끝냈어요 · ${title}`,
    failedTitle: (title: string) => `${title} · 하다가 멈췄어요`,
    /** The result line when a task ended with no answer */
    noAnswer: '하던 일을 마쳤어요. 자세한 단계는 카드에서 볼 수 있어요.',
  },
  en: {
    briefShown: (title: string) => `Working on: ${title}.`,
    noteShown: (note: string) => `Passed on: "${note}".`,
    doneTitle: (title: string) => `Done · ${title}`,
    failedTitle: (title: string) => `${title} · stopped partway`,
    noAnswer: 'The task is finished. The card shows its steps.',
  },
})
