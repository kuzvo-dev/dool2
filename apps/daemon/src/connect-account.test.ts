import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { type ConnectCard, ConnectCardSchema } from '@dool2/protocol/connect'
import { describe, expect, it } from 'vitest'
import { accountIn, accountName, accountPage, readAccount, sameSignIn } from './connect-account.js'

const skill = async (id: string): Promise<ConnectCard> =>
  ConnectCardSchema.parse(
    JSON.parse(
      await readFile(fileURLToPath(new URL(`../../../skills/${id}/connect.json`, import.meta.url)), 'utf8'),
    ),
  )

/** Gmail's bar as the snapshot reads it (measured: the account button label) */
const inbox = (who: string, u = 0) => ({
  url: `https://mail.google.com/mail/u/${u}/#inbox`,
  text: `[e14 버튼 "Google 계정: 쿠즈보 (${who})"]\n[e18 버튼 "편지쓰기"]\n받은편지함`,
})
/** What Gmail shows for /mail/u/<an account not in Chrome>/ (measured 2026-11-25) */
const notInChrome = {
  url: 'https://mail.google.com/mail/u/c%40gmail.com/',
  text: 'Gmail\nTemporary Error (404)\nWe’re sorry, but your account is temporarily unavailable.',
}

function browserShowing(page: { url: string; text: string }) {
  const calls: [string, Record<string, unknown>][] = []
  return {
    calls,
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params])
      if (method === 'open') return { tabId: 3 }
      if (method === 'snapshot') return page
      return {}
    },
  }
}

describe('which account a connection is', () => {
  it('writes a bare Google ID as the full address', async () => {
    const gmail = await skill('gmail')
    expect(accountName(gmail, 'kuzvo')).toBe('kuzvo@gmail.com')
    expect(accountName(gmail, 'kuzvo@company.com')).toBe('kuzvo@company.com')
    expect(accountName(await skill('kakao'), 'kuzvo')).toBe('kuzvo')
  })

  it("fills the account into the page address, or the browser's first account", async () => {
    const gmail = await skill('gmail')
    expect(accountPage(gmail, 'a@gmail.com')).toBe('https://mail.google.com/mail/u/a%40gmail.com/')
    expect(accountPage(gmail)).toBe('https://mail.google.com/mail/u/0/')
  })

  it("reads the account only on the service's own site", async () => {
    const gmail = await skill('gmail')
    expect(accountIn(gmail, inbox('a@gmail.com'))).toBe('a@gmail.com')
    // The chooser shows every account in Chrome: none of them is "the" account
    expect(
      accountIn(gmail, {
        url: 'https://accounts.google.com/v3/signin/accountchooser',
        text: '[e4 링크 "Google 계정: 쿠즈보 (a@gmail.com)"]',
      }),
    ).toBeUndefined()
    expect(accountIn(gmail, notInChrome)).toBeUndefined()
  })

  it('compares what was typed with what the page shows', () => {
    expect(sameSignIn('a@gmail.com', 'A@gmail.com')).toBe(true)
    expect(sameSignIn('kuzvo', 'kuzvo@gmail.com')).toBe(true)
    expect(sameSignIn('kuzvo@gmail.com', 'k***@gmail.com')).toBe(true)
    expect(sameSignIn('a@gmail.com', 'b@gmail.com')).toBe(false)
    expect(sameSignIn('01012345678', 'a@kakao.com')).toBe(false)
  })

  it('says another account is signed in (the case that looked "connected" before)', async () => {
    const gmail = await skill('gmail')
    const b = browserShowing(inbox('b@gmail.com'))
    // Gmail addressed by account shows that account or a 404, so "other" comes from cards without {{account}}
    const kakao = await skill('kakao')
    const k = browserShowing({
      url: 'https://accounts.kakao.com/weblogin/account/info',
      text: '[e2 링크 "b@kakao.com 계정 정보로 이동"]',
    })
    expect(await readAccount(k, kakao, 'a@kakao.com', { wait: 0 })).toEqual({
      state: 'other',
      who: 'b@kakao.com',
    })
    expect(await readAccount(b, gmail, 'b', { wait: 0 })).toEqual({ state: 'match', who: 'b@gmail.com' })
    // The tab it opened is closed again
    expect(b.calls.at(-1)).toEqual(['close', { tabId: 3 }])
  })

  it('says the typed account is not in Chrome when its own address shows no account (Gmail 404)', async () => {
    const gmail = await skill('gmail')
    const b = browserShowing(notInChrome)
    expect(await readAccount(b, gmail, 'c@gmail.com', { wait: 0 })).toEqual({ state: 'none' })
    expect(b.calls[0]).toEqual(['open', { url: 'https://mail.google.com/mail/u/c%40gmail.com/' }])
  })

  it('reads whoever is signed in when nothing was typed, and stays unsure without a card spec', async () => {
    expect(
      await readAccount(browserShowing(inbox('a@gmail.com')), await skill('gmail'), undefined, { wait: 0 }),
    ).toEqual({ state: 'match', who: 'a@gmail.com' })
    const plain = { id: 'shop', site: 'shop.example' } as ConnectCard
    expect(await readAccount(browserShowing(inbox('a@gmail.com')), plain, 'a', { wait: 0 })).toEqual({
      state: 'unknown',
    })
  })
})
