// Placeholder title of a thread that has no message yet. The stored value stays Korean for existing rows, and
// the first user message replaces it (see ThreadService.send in @dool2/engine).
export const NEW_THREAD_TITLE = {
  ko: '새 대화',
  en: 'New chat',
} as const

/** Whether a stored title is still the placeholder, in any language */
export function isNewThreadTitle(title: string): boolean {
  return Object.values(NEW_THREAD_TITLE).includes(title as never)
}
