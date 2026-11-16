// 스토어 앱(Capacitor)에서만 쓰는 것: 공식 중계 서버, PC 화면의 QR 찍기, 링크로 열기, 뒤로 가기.
// 브라우저에서 열면 모두 꺼진다. 앱 코드는 앱 안에 담겨 있어서 서버가 바꿔치기할 수 없다 (ADR 0012 보완).

import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning'
import { OFFICIAL_RELAY } from '@dool2/protocol/link'

export const isNative = () => Capacitor.isNativePlatform()

/** 초대에 중계 주소가 없을 때: 앱이면 공식 중계 서버, 브라우저면 앱을 연 주소 */
export const defaultRelay = () => (isNative() ? OFFICIAL_RELAY : location.origin)

/** 주소나 QR 내용에서 연결 초대(#p=…)를 꺼낸다 */
export const inviteFrom = (text: string) => /#p=([\w-]+)/.exec(text)?.[1]

/**
 * PC 화면의 QR을 찍는다. 구글 코드 스캐너를 써서 카메라 권한을 따로 묻지 않는다.
 * 찍은 내용(주소)을 돌려주고, 취소하면 undefined
 */
export async function scanQr(): Promise<string | undefined> {
  const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()
  if (!available) {
    await BarcodeScanner.installGoogleBarcodeScannerModule()
    throw new Error('QR 스캐너를 받는 중이에요. 잠시 뒤 다시 눌러 주세요')
  }
  try {
    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] })
    return barcodes[0]?.rawValue
  } catch (e) {
    if (/cancel/i.test(String((e as Error).message))) return undefined
    throw e
  }
}

/** 이미 쓴 연결 초대 (앱이 다시 켜질 때 안드로이드가 처음 링크를 또 넘겨줘서, 같은 초대로 다시 연결하지 않게) */
const USED = 'dool2-used-invites'
function used(): string[] {
  try {
    return JSON.parse(localStorage.getItem(USED) ?? '[]') as string[]
  } catch {
    return []
  }
}
/** 처음 보는 초대면 쓴 것으로 적고 true */
export function claimInvite(invite: string): boolean {
  const list = used()
  if (list.includes(invite)) return false
  localStorage.setItem(USED, JSON.stringify([...list, invite].slice(-10)))
  return true
}

/** 앱이 꺼져 있다가 연결 링크(dool2://pair#p=…)로 켜졌으면 그 초대 (이미 쓴 초대면 없음) */
export async function launchInvite(): Promise<string | undefined> {
  if (!isNative()) return undefined
  const url = (await App.getLaunchUrl())?.url
  const invite = url ? inviteFrom(url) : undefined
  return invite && claimInvite(invite) ? invite : undefined
}

/** 앱 밖에서 링크(https://…#p=…)로 열렸을 때, 안드로이드 뒤로 가기 */
export function listenNative(on: { open(url: string): void; back(): boolean }) {
  if (!isNative()) return
  void App.addListener('appUrlOpen', (e) => {
    // 시작 링크가 이벤트로 한 번 더 오거나, 화면이 다시 켜지며 처음 링크가 또 온다: 쓴 초대는 넘긴다
    const invite = inviteFrom(e.url)
    if (invite && claimInvite(invite)) on.open(e.url)
  })
  void App.addListener('backButton', () => {
    if (!on.back()) void App.minimizeApp()
  })
}
