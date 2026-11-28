// Pairing: the one-time handshake that tells the daemon which device key to trust. The phone reads its public key
// out of the keystore seam (never the private key) and hands it to the daemon, which stores it; from then on the
// daemon verifies every approval signature against that key (@dool2/approvals verifyApproval). This module is the
// client half and the message shapes — the daemon side is Agentd.registerDevice, which this models through the
// small `DeviceRegistrar` seam so the real daemon satisfies it directly.

import { randomUUID } from 'node:crypto'
import type { KeyStore } from './keystore.js'

/** The pairing message the phone sends the daemon. Carries only the public key and device identity — no secret. */
export interface PairRequest {
  /** A stable id for this device, so a re-pair replaces the same device rather than adding a second. */
  deviceId: string
  /** The device public key (SPKI Ed25519 PEM) the daemon stores and verifies against. */
  publicKeyPem: string
  /** A human name for the device, for the daemon's device list ("Minjun's iPhone"). Optional. */
  label?: string
  /** Unix ms the phone built the request. */
  pairedAt: number
}

/** The daemon's reply to a pair request. */
export interface PairResponse {
  ok: boolean
  /** A short machine reason when pairing failed, for the log. */
  reason?: string
}

/**
 * The daemon seam pairing needs: store (register) a device public key. The real @dool2/agentd Agentd satisfies this
 * with its `registerDevice(publicKeyPem)` method, so `pairDevice(agentd, keystore)` works directly against it. A
 * network transport would implement this by POSTing the {@link PairRequest} to the daemon's pair endpoint.
 */
export interface DeviceRegistrar {
  registerDevice(publicKeyPem: string): void | Promise<void>
}

/** The outcome of pairing: the request the phone sent and the daemon's response. */
export interface PairResult {
  request: PairRequest
  response: PairResponse
}

export interface PairOptions {
  /** A stable device id; a random one is minted if omitted. */
  deviceId?: string
  /** A human device name. */
  label?: string
  /** Clock, for tests. */
  now?: number
}

/**
 * Pair this device with the daemon: read the public key from the keystore seam and register it with the daemon. The
 * private key stays in the chip. Returns the exact request sent and the response, so the caller (and tests) can see
 * the message shapes. If the daemon throws, pairing fails closed with a reason rather than rejecting.
 */
export async function pairDevice(
  daemon: DeviceRegistrar,
  keystore: KeyStore,
  opts: PairOptions = {},
): Promise<PairResult> {
  const publicKeyPem = await keystore.getPublicKeyPem()
  const request: PairRequest = {
    deviceId: opts.deviceId ?? randomUUID(),
    publicKeyPem,
    ...(opts.label !== undefined ? { label: opts.label } : {}),
    pairedAt: opts.now ?? Date.now(),
  }
  try {
    await daemon.registerDevice(publicKeyPem)
    return { request, response: { ok: true } }
  } catch (err) {
    return { request, response: { ok: false, reason: err instanceof Error ? err.message : 'pair-failed' } }
  }
}
