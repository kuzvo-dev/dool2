// The v1-compat phone link's CONNECTIONS + phone-first LOGIN + VAULT over the relay (legacy-phone.ts), fed straight
// into LegacyPhoneLink.handle() over real sealed envelopes (the relay transport is identical and covered elsewhere).
// It proves the "Dool2 does it, the person only logs in" flow restored for the ALREADY-SHIPPED app against the v2
// daemon: a `connections` request returns the service list; a `connect-login`/`login` carrying credentials stores
// them in the engine's vault and the AI only ever sees a masked summary (no secret in any AI-visible transcript); a
// mid-task `login-request` is answered by the phone's `login` and the running turn resumes; `vault-get` returns
// masked items with no password; and `vault-reveal` is gated on the vault being unlocked.

import type { Brain } from '@dool2/brains'
import type { PcToPhone, PhoneToPc, VaultEntry } from '@dool2/protocol'
import type { ConnectCard, ConnectionItem } from '@dool2/protocol/connect'
import {
  type DeviceKeys,
  type Envelope,
  generateDevice,
  LINK_VERSION,
  linkKey,
  open,
  seal,
} from '@dool2/protocol/e2e'
import { makeFakeBridges, type PageBridge, type PageSnapshot } from '@dool2/sandbox'
import { describe, expect, it } from 'vitest'
import { Agentd } from './agentd.js'
import { LegacyPhoneLink } from './legacy-phone.js'
import { InMemoryVault, makeVaultBridge } from './vault.js'

const SECRET = 'pairing-secret-fixture-24bytes!'
const PASSWORD = 'SECRETpw-do-not-leak-98765'

/** A login page (the shipped app lands on a site's sign-in form): a username + password field and a submit button. */
function loginPage(url = 'https://nid.naver.com/login'): PageBridge & { filled: string[] } {
  const filled: string[] = []
  return {
    filled,
    async snapshot(): Promise<PageSnapshot> {
      return {
        url,
        title: 'Sign in',
        nodes: [
          { ref: 'u1', role: 'textbox', name: 'Email' },
          { ref: 'p1', role: 'textbox', name: 'Password' },
          { ref: 'b1', role: 'button', name: 'Sign in' },
        ],
      }
    },
    async fetch() {
      return { status: 200, headers: {}, body: '' }
    },
    async goto() {},
    async click() {},
    async type() {},
    async press() {},
    // The secret path: the ref is recorded, never the value (matching the real contract).
    async fill(ref: string): Promise<void> {
      filled.push(ref)
    },
  }
}

/** A brain that runs one code-hand call, then ends on the next turn. */
function codeBrain(code: string): Brain {
  return {
    id: 'pi',
    label: 'code',
    async ready() {
      return true
    },
    async *run(input) {
      if (input.messages.some((m) => m.role === 'tool')) {
        yield { kind: 'turn_end', stop: 'done' }
        return
      }
      yield { kind: 'tool_call', call: { id: 'c1', name: 'code', args: { code } } }
      yield { kind: 'turn_end', stop: 'tool' }
    },
  }
}

/** A minimal ConnectionItem: the link reads only card.id and card.site, so a partial card is enough for the test. */
function connection(id: string, site: string, name: string): ConnectionItem {
  return { card: { id, name, site } as unknown as ConnectCard }
}

interface Harness {
  agentd: Agentd
  vault: InMemoryVault
  link: LegacyPhoneLink
  phone: V1Phone
  page: ReturnType<typeof loginPage>
}

/** Build a daemon whose vault bridge is the REAL makeVaultBridge over an InMemoryVault, plus a paired v1 phone. */
async function setup(
  opts: {
    brain?: Brain
    vault?: InMemoryVault
    connections?: ConnectionItem[]
    page?: ReturnType<typeof loginPage>
  } = {},
): Promise<Harness> {
  const pc = await generateDevice(true)
  const vault = opts.vault ?? new InMemoryVault([], { accountPolicy: 'always' })
  const page = opts.page ?? loginPage()
  const fake = makeFakeBridges()
  const bridges = {
    page,
    vault: makeVaultBridge(vault, { page, level: () => 'ask' as const }),
    pc: fake.pc,
    fs: fake.fs,
  }
  const agentd = new Agentd({ brain: opts.brain ?? codeBrain('1'), bridges, level: 'ask' })
  const link = new LegacyPhoneLink({
    keys: pc,
    agentd,
    secret: SECRET,
    relayUrl: 'https://relay.example.com',
    pcName: 'Dool2 PC',
    vault,
    connections: () => opts.connections ?? [],
    send: (env) => phone.outbox.push(env),
  })
  const phone = new V1Phone(link, pc.id, pc.boxPub)
  await phone.init()
  await phone.pair()
  return { agentd, vault, link, phone, page }
}

/** A v1-shaped phone driven straight against a LegacyPhoneLink over real sealed envelopes. */
class V1Phone {
  keys!: DeviceKeys
  private key!: Awaited<ReturnType<typeof linkKey>>
  private seq = 0
  readonly outbox: Envelope[] = []

  constructor(
    private readonly link: LegacyPhoneLink,
    private readonly pcId: string,
    private readonly pcBoxPub: string,
  ) {}

  async init(): Promise<void> {
    this.keys = await generateDevice(false)
    this.key = await linkKey(this.keys.boxPriv, this.pcBoxPub, [this.keys.id, this.pcId])
  }

  private async up(kind: PhoneToPc['kind'], body: PhoneToPc, pub?: string): Promise<void> {
    this.seq += 1
    await this.link.handle(
      await seal(
        this.key,
        { v: LINK_VERSION, from: this.keys.id, to: this.pcId, kind, seq: this.seq, ...(pub ? { pub } : {}) },
        body,
      ),
    )
  }

  async received(): Promise<PcToPhone[]> {
    return Promise.all(this.outbox.map((env) => open<PcToPhone>(this.key, env)))
  }

  async pair(): Promise<void> {
    await this.up(
      'pair',
      { kind: 'pair', secret: SECRET, signPub: this.keys.signPub, name: 'Test iPhone' },
      this.keys.boxPub,
    )
  }

  async send(msg: PhoneToPc): Promise<void> {
    await this.up(msg.kind, msg)
  }
}

/** Every reply of one kind the phone received, in order. */
function of<K extends PcToPhone['kind']>(msgs: PcToPhone[], kind: K): Extract<PcToPhone, { kind: K }>[] {
  return msgs.filter((m): m is Extract<PcToPhone, { kind: K }> => m.kind === kind)
}

describe('v1-compat phone connections', () => {
  it('answers a connections request with the service list', async () => {
    const h = await setup({ connections: [connection('coupang', 'coupang.com', 'Coupang')] })
    h.phone.outbox.length = 0
    await h.phone.send({ kind: 'connections' })
    const list = of(await h.phone.received(), 'connections').at(-1)
    expect(list?.services.map((s) => s.card.id)).toEqual(['coupang'])
  })

  it('marks a service connected and reflects it in the list', async () => {
    const h = await setup({ connections: [connection('coupang', 'coupang.com', 'Coupang')] })
    h.phone.outbox.length = 0
    await h.phone.send({ kind: 'connect', id: 'coupang', action: 'mark' })
    const list = of(await h.phone.received(), 'connections').at(-1)
    expect(list?.services[0]?.connectedAt).toBeTruthy()
  })
})

describe('v1-compat phone-first login -> vault (secret never reaches the AI)', () => {
  it('connect-login stores the credential in the vault; the AI only sees a masked summary', async () => {
    const h = await setup({ connections: [connection('coupang', 'coupang.com', 'Coupang')] })
    h.phone.outbox.length = 0
    await h.phone.send({
      kind: 'connect-login',
      id: 'coupang',
      username: 'shopper@example.com',
      password: PASSWORD,
    })

    // The connect succeeded and the credential is in the vault — but no masked view carries the secret.
    const result = of(await h.phone.received(), 'connect-result').at(-1)
    expect(result?.ok).toBe(true)
    const summaries = h.vault.summaries()
    expect(summaries.some((s) => s.site === 'coupang.com' && s.username === 'shopper@example.com')).toBe(true)
    expect(JSON.stringify(summaries)).not.toContain(PASSWORD)
    expect(JSON.stringify(h.vault.phoneEntries())).not.toContain(PASSWORD)

    // And the AI-facing vault list (what a turn's code hand reads) carries no password either.
    const ai = await setup({
      vault: h.vault,
      brain: codeBrain('JSON.stringify(await vault.listItems())'),
    })
    const turn = await ai.agentd.send('what logins do I have?')
    expect(JSON.stringify(turn.transcript)).not.toContain(PASSWORD)
    expect(JSON.stringify(turn.transcript)).toContain('coupang.com')
  })

  it('a mid-task fillLogin with no stored credential asks the phone, stores its login, and the turn resumes', async () => {
    const page = loginPage('https://nid.naver.com/login')
    const h = await setup({ brain: codeBrain('await vault.fillLogin("naver")'), page })

    // The engine turn blocks inside fillLogin on the phone-first login request; run it concurrently.
    const running = h.agentd.send('log me into naver')
    // Let the login-request flush to the phone (the sandbox runs async), read its id, and answer it as the sheet would.
    let request = of(await h.phone.received(), 'login-request').at(-1)?.request
    for (let i = 0; i < 100 && !request; i++) {
      await new Promise((r) => setTimeout(r, 2))
      request = of(await h.phone.received(), 'login-request').at(-1)?.request
    }
    expect(request).toBeDefined()
    expect(request?.site).toBe('nid.naver.com')
    await h.phone.send({ kind: 'login', id: request?.id ?? '', username: 'me@naver.com', password: PASSWORD })

    const result = await running // the turn resumes and finishes now that the login exists
    // The fill actually happened (username + password typed into the page), and the vault now holds the login.
    expect(page.filled.length).toBeGreaterThan(0)
    expect(h.vault.summaries().some((s) => s.site === 'nid.naver.com')).toBe(true)
    // The password never crossed to the AI: not in the transcript, not in the vault's AI summary.
    expect(JSON.stringify(result.transcript)).not.toContain(PASSWORD)
    expect(JSON.stringify(h.vault.summaries())).not.toContain(PASSWORD)
    // The phone sees the sheet resolve.
    expect(of(await h.phone.received(), 'login-done').at(-1)?.ok).toBe(true)
  })
})

describe('v1-compat phone vault screen (ADR 0011/0026)', () => {
  it('vault-get returns masked entries with no secret values', async () => {
    const vault = new InMemoryVault([], { accountPolicy: 'always' })
    vault.upsertLogin({ site: 'naver.com', username: 'me@naver.com', password: PASSWORD })
    const h = await setup({ vault })
    h.phone.outbox.length = 0
    await h.phone.send({ kind: 'vault-get' })
    const reply = of(await h.phone.received(), 'vault').at(-1)
    const entries: VaultEntry[] = reply?.entries ?? []
    expect(entries.map((e) => e.username)).toContain('me@naver.com')
    expect(JSON.stringify(entries)).not.toContain(PASSWORD)
    // VaultEntry has no password field by construction.
    for (const e of entries) expect('password' in (e as object)).toBe(false)
  })

  it('vault-reveal is gated on the vault being unlocked', async () => {
    const vault = new InMemoryVault([], { accountPolicy: 'always' })
    const id = vault.upsertLogin({ site: 'naver.com', username: 'me@naver.com', password: PASSWORD })
    const h = await setup({ vault })

    // Locked: no secret crosses — only the list with a note.
    h.phone.outbox.length = 0
    await h.phone.send({ kind: 'vault-reveal', id })
    expect(of(await h.phone.received(), 'vault-secret')).toHaveLength(0)
    expect(of(await h.phone.received(), 'vault').at(-1)?.message).toBeTruthy()

    // Unlocked: the paired phone (not the AI) may see the password briefly.
    vault.unlock()
    h.phone.outbox.length = 0
    await h.phone.send({ kind: 'vault-reveal', id })
    const secret = of(await h.phone.received(), 'vault-secret').at(-1)
    expect(secret?.username).toBe('me@naver.com')
    expect(secret?.password).toBe(PASSWORD)
  })

  it('vault-delete removes an item', async () => {
    const vault = new InMemoryVault([], { accountPolicy: 'always' })
    const id = vault.upsertLogin({ site: 'naver.com', username: 'me@naver.com', password: PASSWORD })
    const h = await setup({ vault })
    h.phone.outbox.length = 0
    await h.phone.send({ kind: 'vault-delete', id })
    const reply = of(await h.phone.received(), 'vault').at(-1)
    expect(reply?.entries).toHaveLength(0)
  })
})
