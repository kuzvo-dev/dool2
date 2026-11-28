// DaemonHttpClient: the phone-side client that reaches a RUNNING daemon over its local HTTP API (apps/agentd http.ts)
// from a DIFFERENT process. It is the network transport behind the two in-process seams this package already defines:
//
//   - DeviceRegistrar (pairing.ts):   registerDevice(publicKeyPem) -> POST /pair. So `pairDevice(client, keystore)`
//                                      pairs over the network exactly as it does in-process; only the PUBLIC key is
//                                      ever sent (the keystore holds the private key and never hands it out).
//   - ApprovalTransport (sign.ts):    approve(hash, signature) -> POST /approve. So `respond`/`approveCard` and the
//                                      PhoneSimulator send a signature back over the network.
//
// Plus the two reads a phone needs to drive the loop: pending() (GET /pending) for the cards awaiting a signature, and
// send() (POST /message) to run a turn and read the final result out of the SSE stream (so a resume can be triggered
// with the approved hashes). This client never holds a private key and never sees a secret: it carries the bearer
// token, the device public key, signatures, and the public facts of a turn — nothing a password/card/PIN hides behind.

import { randomUUID } from 'node:crypto'
import type { ApprovalNeeded } from './approval-card.js'
import type { DeviceRegistrar, PairRequest } from './pairing.js'
import type { ApprovalTransport, RespondResult } from './sign.js'

export interface DaemonHttpClientOptions {
  /** The daemon base URL, e.g. http://127.0.0.1:53219 (printed by `agentd serve`). A trailing slash is fine. */
  baseUrl: string
  /** The bearer token the daemon requires on every endpoint but /health. */
  token: string
  /** A stable device id sent at pairing, so a re-pair replaces the same device. A random one is minted if omitted. */
  deviceId?: string
  /** A human device name for the daemon's device list ("Minjun's iPhone"). Optional. */
  label?: string
  /** fetch seam, for tests that want to inject one. Defaults to the global fetch. */
  fetch?: typeof fetch
  /** Clock seam (unix ms), for the pairing timestamp. Defaults to Date.now. */
  now?: () => number
}

/** One gate decision as the daemon reports it in a turn result — the public facts, no secret. */
export interface TurnGateDecision {
  label: string
  tier: string
  decision: string
  reason: string
  allowed: boolean
  amountKrw?: number
}

/** The subset of a turn's SendResult a phone client reads back off the SSE stream after POST /message. */
export interface TurnSummary {
  stop: string
  /** The approval cards this turn minted, each signable with the device key. */
  approvalsNeeded: ApprovalNeeded[]
  gateDecisions: TurnGateDecision[]
  blocked: { label: string; tier: string; reason: string }[]
}

/** Options for a network turn (POST /message). */
export interface SendOverHttp {
  /** The URL of the active tab, handed to the engine so skills match and the gate can read the page. */
  url?: string
  /** Override the session autonomy level for this one turn. */
  level?: 'ask' | 'auto' | 'full'
  /** Envelope hashes already signed via POST /approve, so the engine resumes exactly those actions (ADR 0047). */
  approved?: string[]
}

/**
 * A phone client over the daemon's local HTTP API. Implements DeviceRegistrar and ApprovalTransport, so it drops
 * straight into `pairDevice`, `respond`, `approveCard`, and the PhoneSimulator. The private key stays on the phone
 * side (in the KeyStore); this client only ever puts a public key, a signature, or a bearer token on the wire.
 */
export class DaemonHttpClient implements DeviceRegistrar, ApprovalTransport {
  readonly #baseUrl: string
  readonly #token: string
  readonly #deviceId: string
  readonly #label: string | undefined
  readonly #fetch: typeof fetch
  readonly #now: () => number

  constructor(opts: DaemonHttpClientOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.#token = opts.token
    this.#deviceId = opts.deviceId ?? randomUUID()
    this.#label = opts.label
    this.#fetch = opts.fetch ?? fetch
    this.#now = opts.now ?? Date.now
  }

  /** The device id this client pairs under (generated if none was given). */
  get deviceId(): string {
    return this.#deviceId
  }

  #headers(): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` }
  }

  /**
   * DeviceRegistrar seam: POST /pair with the device PUBLIC key (plus the device id/label). Only the public key is
   * sent — the private key never leaves the keystore. Throws on a non-2xx so `pairDevice` reports a failed pairing
   * with the daemon's reason.
   */
  async registerDevice(publicKeyPem: string): Promise<void> {
    const request: PairRequest = {
      deviceId: this.#deviceId,
      publicKeyPem,
      ...(this.#label !== undefined ? { label: this.#label } : {}),
      pairedAt: this.#now(),
    }
    const res = await this.#fetch(`${this.#baseUrl}/pair`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(request),
    })
    if (!res.ok) {
      const reason = await readReason(res)
      throw new Error(`pair failed: ${res.status}${reason ? ` ${reason}` : ''}`)
    }
  }

  /** GET /pending: the approval cards still awaiting a phone signature, in registration order. */
  async pending(): Promise<ApprovalNeeded[]> {
    const res = await this.#fetch(`${this.#baseUrl}/pending`, { headers: this.#headers() })
    if (!res.ok) throw new Error(`pending failed: ${res.status}`)
    const body = (await res.json()) as { pending?: ApprovalNeeded[] }
    return body.pending ?? []
  }

  /**
   * ApprovalTransport seam: POST /approve { hash, signature }. Returns the daemon's verify result as a RespondResult
   * (ok plus a machine reason on refusal). A non-2xx carries the daemon's reason, so a tampered signature or an
   * unknown hash comes back as { ok: false, reason }.
   */
  async approve(hash: string, signature: string): Promise<RespondResult> {
    const res = await this.#fetch(`${this.#baseUrl}/approve`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify({ hash, signature }),
    })
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string }
    const ok = res.ok && body.ok === true
    return { ok, ...(body.reason !== undefined ? { reason: body.reason } : {}) }
  }

  /**
   * POST /message: run a turn and read the final result out of the SSE stream. Returns the turn summary (stop, the
   * approval cards it minted, the gate log, the blocks). Pass `approved` to resume actions already signed via approve.
   */
  async send(message: string, opts: SendOverHttp = {}): Promise<TurnSummary> {
    const res = await this.#fetch(`${this.#baseUrl}/message`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify({ message, ...opts }),
    })
    if (!res.ok) throw new Error(`message failed: ${res.status}`)
    return parseResultEvent(await res.text())
  }
}

/** Read a short machine reason from a JSON error body, if there is one. */
async function readReason(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => ({}))) as { reason?: string; error?: string }
  return body.reason ?? body.error
}

/**
 * Pull the final `event: result` payload out of an SSE body (see http.ts streamTurn). The stream is a run of
 * `data: {json}\n\n` event blocks ending in an `event: result\ndata: {json}\n\n`; we take that last one. An
 * `event: error` block (a turn that threw on the daemon) is re-thrown here.
 */
function parseResultEvent(sse: string): TurnSummary {
  const blocks = sse.split('\n\n')
  for (const block of blocks) {
    if (!block.startsWith('event: result')) continue
    const line = block.split('\n').find((l) => l.startsWith('data: '))
    if (!line) continue
    const json = JSON.parse(line.slice('data: '.length)) as Partial<TurnSummary>
    return {
      stop: String(json.stop ?? 'done'),
      approvalsNeeded: json.approvalsNeeded ?? [],
      gateDecisions: json.gateDecisions ?? [],
      blocked: json.blocked ?? [],
    }
  }
  const errBlock = blocks.find((b) => b.startsWith('event: error'))
  if (errBlock) {
    const line = errBlock.split('\n').find((l) => l.startsWith('data: '))
    const msg = line ? (JSON.parse(line.slice('data: '.length)) as { error?: string }).error : undefined
    throw new Error(`turn errored: ${msg ?? 'unknown'}`)
  }
  throw new Error('no result event in the stream')
}
