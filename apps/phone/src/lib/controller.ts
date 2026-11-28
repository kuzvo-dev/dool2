// The phone app's state machine, with no DOM and no copy — the renderer subscribes and draws, the tests drive it
// directly. It closes the human-in-the-loop safety loop from the phone's side (ADR 0043, 0047):
//
//   connect()  → pairDevice over DaemonHttpClient (POST /pair). Only the device PUBLIC key goes on the wire; the
//                private key stays in the keystore seam. On success the phone is paired and starts polling.
//   refresh()  → GET /pending for the cards awaiting a signature; the first becomes the sheet the user sees.
//   approve()  → sign the card's envelope hash with the device key and POST /approve. The daemon verifies and resumes
//                the one action on the PC. The signature + the stored public key are all that cross the wire.
//   reject()   → dismiss the card WITHOUT signing (nothing is sent; the action does not run).
//   handOff()  → the user will do this one themselves on the PC; dismiss without signing.
//
// A secret never reaches here: the card carries only public facts and masked display text. The controller holds a
// DaemonHttpClient and a KeyStore; in demo/offline mode there is no client, and a seeded card drives the same screens.

import type { KeyStore } from '@dool2/phone'
import { DaemonHttpClient, pairDevice } from '@dool2/phone'
import type { PendingCard } from './card.js'
import { signPending } from './card.js'

/** What the user just did with a card, so the sheet can reflect "Approved" / "Declined" before it closes. */
export type Outcome = 'approved' | 'rejected' | 'handed-off'

export interface PhoneState {
  /** demo = seeded card, no daemon; live = paired to a daemon over HTTP. */
  mode: 'demo' | 'live'
  connected: boolean
  busy: boolean
  deviceId?: string
  /** The card shown in the bottom sheet, or undefined when idle (home screen). */
  card?: PendingCard
  outcome?: Outcome
  error?: string
}

export interface ConnectInput {
  baseUrl: string
  token: string
  label?: string
  deviceId?: string
}

export interface ControllerDeps {
  keystore: KeyStore
  /** fetch seam for the DaemonHttpClient (tests inject one; the browser uses the global). */
  fetch?: typeof fetch
  /** A seeded card for demo/offline mode, shown with no daemon. */
  demoCard?: PendingCard
}

type Listener = (state: PhoneState) => void

export class PhoneController {
  #state: PhoneState
  readonly #keystore: KeyStore
  readonly #fetch: typeof fetch | undefined
  #demoCard: PendingCard | undefined
  #client: DaemonHttpClient | undefined
  readonly #listeners = new Set<Listener>()

  constructor(deps: ControllerDeps) {
    this.#keystore = deps.keystore
    this.#fetch = deps.fetch
    this.#demoCard = deps.demoCard
    this.#state = { mode: 'demo', connected: false, busy: false }
  }

  /** Seed (or replace) the offline demo card. Built asynchronously (its hash is a WebCrypto digest), so it is set
   *  after construction rather than passed in. */
  setDemoCard(card: PendingCard): void {
    this.#demoCard = card
  }

  get state(): PhoneState {
    return this.#state
  }

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn)
    fn(this.#state)
    return () => this.#listeners.delete(fn)
  }

  #set(patch: Partial<PhoneState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const fn of this.#listeners) fn(this.#state)
  }

  /** Show the seeded demo card over the home screen (offline mode; also what the smoke screenshot captures). */
  showDemo(): void {
    this.#set({ mode: 'demo', connected: false, card: this.#demoCard, outcome: undefined, error: undefined })
  }

  /** Pair with the PC: register the device PUBLIC key over POST /pair. The private key never leaves the keystore. */
  async connect(input: ConnectInput): Promise<boolean> {
    this.#set({ busy: true, error: undefined })
    const client = new DaemonHttpClient({
      baseUrl: input.baseUrl,
      token: input.token,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      ...(this.#fetch !== undefined ? { fetch: this.#fetch } : {}),
    })
    const result = await pairDevice(client, this.#keystore, {
      deviceId: client.deviceId,
      ...(input.label !== undefined ? { label: input.label } : {}),
    })
    if (!result.response.ok) {
      this.#set({ busy: false, connected: false, error: result.response.reason ?? 'pair-failed' })
      return false
    }
    this.#client = client
    this.#set({ mode: 'live', connected: true, busy: false, deviceId: client.deviceId, card: undefined })
    return true
  }

  /** Poll GET /pending; the first card awaiting a signature becomes the sheet. No-op in demo mode. */
  async refresh(): Promise<void> {
    if (!this.#client) return
    const cards = await this.#client.pending()
    this.#set({ card: cards[0], outcome: undefined })
  }

  /** Sign the current card with the device key and POST /approve. The daemon verifies and resumes the action. */
  async approve(): Promise<boolean> {
    const card = this.#state.card
    if (!card) return false
    this.#set({ busy: true, error: undefined })
    const signature = await signPending(card, this.#keystore)
    if (!this.#client) {
      // Demo mode: the signature was produced by the real device key, but there is no daemon to post it to.
      this.#set({ busy: false, outcome: 'approved' })
      return true
    }
    const res = await this.#client.approve(card.hash, signature)
    if (!res.ok) {
      this.#set({ busy: false, error: res.reason ?? 'approve-failed' })
      return false
    }
    this.#set({ busy: false, outcome: 'approved' })
    return true
  }

  /** Dismiss the card WITHOUT signing: nothing is sent and the action does not run. */
  reject(): void {
    if (!this.#state.card) return
    this.#set({ outcome: 'rejected' })
  }

  /** Hand-off ("I'll do it myself"): the user will do this one on the PC. Dismiss without signing. */
  handOff(): void {
    if (!this.#state.card) return
    this.#set({ outcome: 'handed-off' })
  }

  /** Close the sheet after an outcome (back to the home screen). */
  dismiss(): void {
    this.#set({ card: undefined, outcome: undefined })
  }
}
