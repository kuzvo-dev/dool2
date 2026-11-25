// Results that end the AI's turn: what was done, what is left, who acts next, and that the turn now waits.
//
// About a quarter of the answers the before-finishing check sent back (ADR 0027) had handed work to the person or
// stopped at a step, and many tool results only said "end this reply". The AI then could not tell a real wait (a
// card on the phone, an approval) from a step it should have tried itself, and neither could the judge. Every result
// that ends a turn is built here, in one shape, and starts with WAIT_MARK so the daemon can count it as evidence that
// the turn is waiting for someone (finish-check.ts).

/** First words of every result that ends the turn to wait (the daemon looks for them) */
export const WAIT_MARK = '⏸ Waiting for'

export interface HandBack {
  /** What Dool2 just did (a card shown, an approval asked, a sign-in started) */
  done: string
  /** What is left, in the words of the step (enter the PIN on the card, approve the move) */
  left: string
  /** Who does what is left: the person, or Dool2 by itself (a sign-in running, a task in line) */
  who: 'person' | 'dool2'
  /** What happens once it is done (how the AI hears of it, what to do then) */
  after: string
  /** What to tell the user, in short (it is said in one or two sentences) */
  tell: string
}

/** The text of a result that ends the turn to wait for the person or for Dool2 */
export function handBack(h: HandBack): string {
  const who = h.who === 'person' ? 'the person' : 'Dool2, by itself'
  return [
    `${WAIT_MARK} ${h.who === 'person' ? 'the person' : 'Dool2'}.`,
    `Done: ${trimDot(h.done)}.`,
    `Left: ${trimDot(h.left)} (${who}).`,
    `Then: ${trimDot(h.after)}.`,
    `This turn ends now: tell the user ${trimDot(h.tell)}, in one or two sentences, and do not ask again or try another way while waiting.`,
  ].join(' ')
}

/** Whether a result text is one that ends the turn to wait */
export function waits(text: string): boolean {
  return text.includes(WAIT_MARK)
}

function trimDot(s: string): string {
  return s.trim().replace(/[.。]+$/, '')
}
