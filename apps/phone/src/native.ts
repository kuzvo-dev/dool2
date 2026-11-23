// 스토어 앱(Capacitor)에서만 쓰는 것: 공식 중계 서버, PC 화면의 QR 찍기, 링크로 열기, 뒤로 가기.
// 브라우저에서 열면 모두 꺼진다. 앱 코드는 앱 안에 담겨 있어서 서버가 바꿔치기할 수 없다 (ADR 0012 보완).

import { App } from '@capacitor/app'
import { Capacitor, registerPlugin } from '@capacitor/core'
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

/** 폰 잠금 확인 (지문·얼굴·PIN). 금고 비밀번호를 보기 전에 (ADR 0026) */
const DeviceAuth = registerPlugin<{
  confirm(o: { title: string; subtitle?: string }): Promise<{ ok: boolean; reason?: string }>
}>('DeviceAuth')

/** ok · no-lock(화면 잠금이 없는 폰) · cancel · web(앱이 아니라 확인할 수 없음 → 보여 주지 않는다) */
export async function confirmDevice(
  title: string,
  subtitle?: string,
): Promise<'ok' | 'no-lock' | 'cancel' | 'web'> {
  if (!isNative()) return 'web'
  try {
    const r = await DeviceAuth.confirm({ title, ...(subtitle ? { subtitle } : {}) })
    return r.ok ? 'ok' : r.reason === 'no-lock' ? 'no-lock' : 'cancel'
  } catch {
    // 예전 앱(플러그인 없음)
    return 'web'
  }
}

/** 보관함 파일을 폰에 저장하거나 다른 앱으로 보내기 (FileSavePlugin.java) */
const FileSave = registerPlugin<{
  save(o: {
    name: string
    mime: string
    data: string
  }): Promise<{ ok: boolean; where?: string; reason?: string }>
  share(o: { name: string; mime: string; data: string }): Promise<{ ok: boolean }>
}>('FileSave')

/** 저장: 앱이면 사진첩·다운로드에, 웹이면 브라우저 내려받기. 결과 한 줄을 돌려준다 */
export async function saveFile(name: string, mime: string, data: string): Promise<string> {
  if (!isNative()) {
    const a = document.createElement('a')
    a.href = `data:${mime};base64,${data}`
    a.download = name
    a.click()
    return '내려받았어요'
  }
  try {
    const r = await FileSave.save({ name, mime, data })
    if (r.ok) return `${r.where ?? '폰'}에 저장했어요`
    if (r.reason === 'old-android') {
      await FileSave.share({ name, mime, data })
      return '이 폰에서는 바로 저장이 안 돼서 보내기 창을 띄웠어요'
    }
    return '저장하지 못했어요'
  } catch (e) {
    // 예전 앱(부품 없음)
    return `저장하지 못했어요: ${(e as Error).message || '새 앱으로 바꿔 주세요'}`
  }
}

/** 보내기: 공유 창 (카톡·메일·드라이브) */
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
    return `보내지 못했어요: ${(e as Error).message || '새 앱으로 바꿔 주세요'}`
  }
}

/** 내 번호로 문자 보내기 (SmsPlugin.java). 사용자가 승인 카드에서 승인한 문자만 보낸다 */
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

/** 이 앱이 문자를 보낼 수 있는지 (앱 + 플러그인 + 전화 기능). 예전 앱·웹이면 false */
export async function smsAvailable(): Promise<boolean> {
  if (!isNative()) return false
  try {
    return (await Sms.available()).ok
  } catch {
    return false
  }
}

/**
 * 연락처·문자 권한: 없으면 한 번에 묻고, 답할 때까지(최대 60초) 1초마다 다시 본다.
 * 권한 창이 떠 있는 동안 앱이 얼려져 플러그인 콜백이 사라지는 일이 있어 콜백에 기대지 않는다
 */
export async function smsPermissions(): Promise<{ contacts: boolean; sms: boolean }> {
  try {
    let p = await Sms.permissions()
    if (p.contacts && p.sms) return p
    await Sms.ask()
    // 창이 둘(연락처·문자) 연달아 뜬다. 둘 다 답하거나 60초가 지날 때까지 본다
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      p = await Sms.permissions()
      if (p.contacts && p.sms) return p
      // 거절했으면 창이 닫히고 앱이 다시 앞에 온다: 그 답으로 끝낸다
      if (i >= 2 && document.hasFocus()) return p
    }
    return p
  } catch {
    return { contacts: false, sms: false }
  }
}

/** 연락처에서 이름으로 찾기 (권한은 smsPermissions로 먼저). denied: 연락처 권한이 없다 */
export async function smsFind(query: string): Promise<{ people: SmsPerson[]; denied?: boolean }> {
  try {
    return await Sms.find({ query })
  } catch {
    return { people: [] }
  }
}

export async function smsSend(to: string, text: string): Promise<{ ok: boolean; message?: string }> {
  try {
    return await Sms.send({ to, text })
  } catch (e) {
    return { ok: false, message: `보내지 못했어요: ${(e as Error).message}` }
  }
}
