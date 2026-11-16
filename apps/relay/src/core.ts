// 중계 서버 규칙. Node 버전(index.ts)과 Cloudflare 버전(worker.ts)이 같이 쓴다.
// 플랫폼 API(소켓·저장소)는 쓰지 않고, 판단만 한다.
import { deviceId, type Envelope, verifyText } from '@dool2/protocol/e2e'
import { helloText } from '@dool2/protocol/link'

export const MAX_MESSAGE = 512 * 1024
export const QUEUE_TTL_MS = 7 * 24 * 60 * 60_000
export const QUEUE_MAX = 500
export const AUTH_SKEW_MS = 2 * 60_000
/** 연결하고 이 시간 안에 증명하지 않으면 끊는다 */
export const AUTH_TIMEOUT_MS = 10_000
/** 연결마다 1초에 보낼 수 있는 수: PC는 여러 폰에 흘려 쓰는 답·실시간 화면을 보내서 넉넉히, 폰은 적게.
 *  넘으면 끊는다 (끊기면 그사이 메시지를 잃으니, 정상 사용으로는 닿지 않게 잡는다) */
export const RATE_LIMIT = { pc: 600, phone: 60 } as const

/** 연결 직후 첫 메시지. ts를 서명해서 다른 연결의 증명을 다시 쓰지 못하게 한다 */
export interface Hello {
  role: 'pc' | 'phone'
  id: string
  signPub: string
  /** 폰: 연결할 PC 방 */
  room?: string
  ts: number
  sig: string
}

export interface Me {
  id: string
  role: 'pc' | 'phone'
  /** 이 기기가 속한 방 (PC id) */
  room: string
}

/** 닫을 때 쓰는 코드 */
export const CLOSE = {
  helloTimeout: 4001,
  badJson: 4002,
  badHello: 4003,
  replaced: 4004,
  badFrom: 4005,
  tooBig: 4006,
  tooFast: 4008,
} as const

/**
 * 첫 메시지가 올바른 기기 증명인지 본다. 맞으면 그 기기, 아니면 undefined.
 * urlRoom: 접속 주소에 실린 방(`/link?room=`). 있으면 증명한 방과 같아야 한다
 */
export async function checkHello(msg: unknown, now: number, urlRoom?: string): Promise<Me | undefined> {
  const h = msg as Hello
  const shape =
    (h?.role === 'pc' || h?.role === 'phone') &&
    typeof h.id === 'string' &&
    typeof h.signPub === 'string' &&
    typeof h.sig === 'string' &&
    Math.abs(now - Number(h.ts)) < AUTH_SKEW_MS &&
    (h.role === 'pc' || typeof h.room === 'string')
  if (!shape) return undefined
  const room = h.role === 'pc' ? h.id : (h.room as string)
  if (urlRoom !== undefined && urlRoom !== room) return undefined
  if ((await deviceId(h.signPub).catch(() => '')) !== h.id) return undefined
  if (!(await verifyText(h.signPub, helloText(h), h.sig))) return undefined
  return { id: h.id, role: h.role, room }
}

export type Route =
  | { ok: false; close: number; reason: string }
  /** drop: 조용히 버린다 (다른 방으로 가는 봉투) */
  | { ok: true; drop: true }
  | { ok: true; drop: false; to: string; queue: boolean }

/**
 * 증명한 기기가 보낸 봉투를 어디로 보낼지 정한다.
 * roomOf: 받는 기기가 속한 방을 알면 돌려준다 (Node 버전은 방을 섞어 들고 있어서 필요하다)
 */
export function route(me: Me, msg: unknown, roomOf?: (id: string) => string | undefined): Route {
  const env = msg as Envelope
  if (env?.from !== me.id || typeof env.to !== 'string')
    return { ok: false, close: CLOSE.badFrom, reason: 'bad from' }
  // 폰은 자기 방의 PC에게만, PC는 자기 방의 폰에게만 보낼 수 있다
  if (me.role === 'phone' && env.to !== me.room) return { ok: true, drop: true }
  const targetRoom = roomOf?.(env.to)
  if (me.role === 'pc' && targetRoom !== undefined && targetRoom !== me.id) return { ok: true, drop: true }
  // 원격 화면은 지금 보는 사람에게만 의미가 있다. 꺼진 기기에 쌓아 두지 않는다
  return { ok: true, drop: false, to: env.to, queue: env.kind !== 'screen' && env.kind !== 'remote' }
}
