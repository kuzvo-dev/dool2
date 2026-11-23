// Chrome install text people see on the setup screen (ADR 0029).
import type { Lang } from '@dool2/i18n'

const ko = {
  offline: '인터넷 연결을 확인해 주세요. Google 서버에 닿지 않았어요',
  serverDown: (status: number) => `Google 서버가 응답하지 않았어요 (${status})`,
  partial: '설치 파일이 다 받아지지 않았어요. 다시 해 주세요',
  cantOpen: '설치 파일을 열지 못했어요',
  cantCopy: 'Chrome을 응용 프로그램 폴더에 넣지 못했어요',
  finishFailed: (code: number | null) => `Chrome 설치를 마치지 못했어요 (종료 코드 ${code})`,
  unsupported: '이 운영체제에서는 Chrome을 직접 설치해 주세요',
  notGoogle: '받은 파일이 Google 공식 Chrome이 아니에요. 안전을 위해 설치를 멈췄어요',
  notFoundAfter: '설치했는데 Chrome을 찾지 못했어요. 다시 확인해 주세요',
  installFailed: (err: string) => `Chrome을 설치하지 못했어요: ${err}`,
}

const en: typeof ko = {
  offline: "Check your internet connection. Couldn't reach Google's servers",
  serverDown: (status) => `Google's server didn't respond (${status})`,
  partial: "The installer didn't finish downloading. Please try again",
  cantOpen: "Couldn't open the installer",
  cantCopy: "Couldn't put Chrome in the Applications folder",
  finishFailed: (code) => `Couldn't finish installing Chrome (exit code ${code})`,
  unsupported: 'Please install Chrome yourself on this operating system',
  notGoogle: "The downloaded file isn't Google's official Chrome. Install stopped to keep you safe",
  notFoundAfter: "Installed, but Chrome can't be found. Please check again",
  installFailed: (err) => `Couldn't install Chrome: ${err}`,
}

export type ChromeText = typeof ko
export const CHROME_TEXT: Record<Lang, ChromeText> = { ko, en }
