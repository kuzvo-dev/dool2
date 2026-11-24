// Pinned instructions (ADR 0032). The AI provider caches the start of every request: the instructions and then the
// conversation so far. Dool2's instructions include things that change during a conversation (what Dool2 remembers,
// what it knows, which services are connected). Rebuilding them on every turn changed that start, so the whole
// conversation after it had to be read again at full price.
//
// So the instructions are pinned when a segment starts and sent unchanged for the rest of it. When a section changes
// later, the next message carries only the changed sections as an update note, once. A new segment (ADR 0015) pins a
// fresh copy again.

/** Splits instructions into sections at "## " headings (the text before the first heading is the "" section) */
export function sections(prompt: string): Map<string, string> {
  const out = new Map<string, string>()
  const parts = prompt.split(/\n(?=## )/)
  for (const part of parts) {
    const head = part.startsWith('## ') ? (part.split('\n', 1)[0] ?? '') : ''
    // Headings can repeat (rare); keep them apart
    let key = head
    for (let n = 2; out.has(key); n++) key = `${head} (${n})`
    out.set(key, part.trim())
  }
  return out
}

/** The heading without its explanation in parentheses, so "What Dool2 knows (today …)" stays one section over days */
function name(head: string): string {
  return head.replace(/\s*\(.*$/, '').trim()
}

/**
 * The update note for instructions that changed since they were pinned: the current text of every section that is
 * new or different, and the names of sections that no longer apply. undefined when nothing changed
 */
export function promptUpdate(pinned: string, fresh: string): string | undefined {
  if (pinned === fresh) return undefined
  const before = new Map([...sections(pinned)].map(([k, v]) => [name(k), v]))
  const now = new Map([...sections(fresh)].map(([k, v]) => [name(k), v]))
  const changed = [...now].filter(([k, v]) => before.get(k) !== v).map(([, v]) => v)
  const gone = [...before.keys()].filter((k) => k && !now.has(k))
  if (!changed.length && !gone.length) return undefined
  return [
    '(Update to your instructions since this conversation started. These sections replace the ones with the same heading above; follow these from now on.)',
    ...changed,
    ...(gone.length ? [`(No longer applies: ${gone.join(', ')})`] : []),
  ].join('\n\n')
}
