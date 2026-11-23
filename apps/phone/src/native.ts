// Store-app (Capacitor) only: official relay, scanning the QR on the PC screen, opening links, the back button.
// All of it is off in a browser. The app code ships inside the app, so a server cannot swap it (ADR 0012 addendum).

import { App } from '@capacitor/app'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning'
import { OFFICIAL_RELAY } from '@dool2/protocol/link'
import { lang } from './lang.js'
import { nativeText } from './locales/native.js'

export const isNative = () => Capacitor.isNativePlatform()

/** When the invite has no relay address: the official relay in the app, the page origin in a browser */
export const defaultRelay = () => (isNative() ? OFFICIAL_RELAY : location.origin)

/** Pulls the pairing invite (#p=…) out of a URL or QR content */
export const inviteFrom = (text: string) => /#p=([\w-]+)/.exec(text)?.[1]

/**
 * Scans the QR on the PC screen. Uses Google's code scanner, so no separate camera permission is asked.
 * Returns the scanned content (a URL), or undefined if cancelled
 */
export async function scanQr(): Promise<string | undefined> {
  const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()
  if (!available) {
    await BarcodeScanner.installGoogleBarcodeScannerModule()
    throw new Error(nativeText(lang).scannerInstalling)
  }
  try {
    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] })
    return barcodes[0]?.rawValue
  } catch (e) {
    if (/cancel/i.test(String((e as Error).message))) return undefined
    throw e
  }
}

/** Invites already used (Android hands over the first link again on relaunch, so the same invite is not paired twice) */
const USED = 'dool2-used-invites'
function used(): string[] {
  try {
    return JSON.parse(localStorage.getItem(USED) ?? '[]') as string[]
  } catch {
    return []
  }
}
/** If the invite is new, marks it as used and returns true */
export function claimInvite(invite: string): boolean {
  const list = used()
  if (list.includes(invite)) return false
  localStorage.setItem(USED, JSON.stringify([...list, invite].slice(-10)))
  return true
}

/** The invite when the app was launched from a pairing link (dool2://pair#p=…); none if already used */
export async function launchInvite(): Promise<string | undefined> {
  if (!isNative()) return undefined
  const url = (await App.getLaunchUrl())?.url
  const invite = url ? inviteFrom(url) : undefined
  return invite && claimInvite(invite) ? invite : undefined
}

/** Opening from a link outside the app (https://…#p=…), and the Android back button */
export function listenNative(on: { open(url: string): void; back(): boolean }) {
  if (!isNative()) return
  void App.addListener('appUrlOpen', (e) => {
    // The launch link can arrive again as an event, or when the screen wakes: skip invites already used
    const invite = inviteFrom(e.url)
    if (invite && claimInvite(invite)) on.open(e.url)
  })
  void App.addListener('backButton', () => {
    if (!on.back()) void App.minimizeApp()
  })
}

/** Phone lock check (fingerprint, face, PIN) before showing vault passwords (ADR 0026) */
const DeviceAuth = registerPlugin<{
  confirm(o: { title: string; subtitle?: string }): Promise<{ ok: boolean; reason?: string }>
}>('DeviceAuth')

/** ok · no-lock (phone has no screen lock) · cancel · web (not the app, cannot verify, so show nothing) */
export async function confirmDevice(
  title: string,
  subtitle?: string,
): Promise<'ok' | 'no-lock' | 'cancel' | 'web'> {
  if (!isNative()) return 'web'
  try {
    const r = await DeviceAuth.confirm({ title, ...(subtitle ? { subtitle } : {}) })
    return r.ok ? 'ok' : r.reason === 'no-lock' ? 'no-lock' : 'cancel'
  } catch {
    // Older app (no plugin)
    return 'web'
  }
}

/** Saves a library file on the phone or sends it to another app (FileSavePlugin.java) */
const FileSave = registerPlugin<{
  save(o: {
    name: string
    mime: string
    data: string
  }): Promise<{ ok: boolean; where?: string; reason?: string }>
  share(o: { name: string; mime: string; data: string }): Promise<{ ok: boolean }>
}>('FileSave')

/** Save: to Photos or Downloads in the app, a browser download on the web. Returns a one-line result */
export async function saveFile(name: string, mime: string, data: string): Promise<string> {
  if (!isNative()) {
    const a = document.createElement('a')
    a.href = `data:${mime};base64,${data}`
    a.download = name
    a.click()
    return nativeText(lang).downloaded
  }
  try {
    const r = await FileSave.save({ name, mime, data })
    if (r.ok) return nativeText(lang).savedTo(r.where ?? nativeText(lang).phone)
    if (r.reason === 'old-android') {
      await FileSave.share({ name, mime, data })
      return nativeText(lang).shareInstead
    }
    return nativeText(lang).saveFailed
  } catch (e) {
    // Older app (no plugin)
    return nativeText(lang).saveFailedWith((e as Error).message || nativeText(lang).updateApp)
  }
}

/** Send: the share sheet (messaging, mail, drive) */
export async function shareFile(name: string, mime: string, data: string): Promise<string | undefined> {
  if (!isNative()) {
    const blob = await (await fetch(`data:${mime};base64,${data}`)).blob()
    const file = new File([blob], name, { type: mime })
    if (navigator.canShare?.({ files: [file] }))
      await navigator.share({ files: [file] }).catch(() => undefined)
    else return saveFile(name, mime, data)
    return undefined
  }
  try {
    await FileSave.share({ name, mime, data })
    return undefined
  } catch (e) {
    return nativeText(lang).shareFailedWith((e as Error).message || nativeText(lang).updateApp)
  }
}

/** Sending a text from my number (SmsPlugin.java). Only texts the user approved on an approval card are sent */
export interface SmsPerson {
  name: string
  number: string
  label: string
}
const Sms = registerPlugin<{
  available(): Promise<{ ok: boolean }>
  permissions(): Promise<{ contacts: boolean; sms: boolean }>
  ask(): Promise<void>
  find(o: { query: string }): Promise<{ people: SmsPerson[]; denied?: boolean }>
  send(o: {
    to: string
    text: string
  }): Promise<{ ok: boolean; parts?: number; reason?: string; message?: string }>
}>('Sms')

/** Whether this app can send texts (app + plugin + telephony). False for older apps and the web */
export async function smsAvailable(): Promise<boolean> {
  if (!isNative()) return false
  try {
    return (await Sms.available()).ok
  } catch {
    return false
  }
}

/**
 * Contacts and SMS permissions: asks once if missing, then checks every second until answered (60 s max).
 * The app can freeze while the permission dialog is up and lose the plugin callback, so we do not rely on it
 */
export async function smsPermissions(): Promise<{ contacts: boolean; sms: boolean }> {
  try {
    let p = await Sms.permissions()
    if (p.contacts && p.sms) return p
    await Sms.ask()
    // Two dialogs (contacts, SMS) appear back to back. Wait until both are answered or 60 s pass
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      p = await Sms.permissions()
      if (p.contacts && p.sms) return p
      // If denied, the dialog closes and the app comes back to the front: end with that answer
      if (i >= 2 && document.hasFocus()) return p
    }
    return p
  } catch {
    return { contacts: false, sms: false }
  }
}

/** Looks up a contact by name (ask permission with smsPermissions first). denied: no contacts permission */
export async function smsFind(query: string): Promise<{ people: SmsPerson[]; denied?: boolean }> {
  try {
    return await Sms.find({ query })
  } catch {
    return { people: [] }
  }
}

/** On failure, reason (denied, no-service, timeout…) and a detail message come back. The screen writes what the user sees */
export async function smsSend(
  to: string,
  text: string,
): Promise<{ ok: boolean; reason?: string; message?: string }> {
  try {
    return await Sms.send({ to, text })
  } catch (e) {
    return { ok: false, reason: 'error', message: (e as Error).message }
  }
}
