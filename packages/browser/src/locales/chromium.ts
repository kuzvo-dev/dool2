// Text people see while Dool2 gets its own browser ready (ADR 0046, ADR 0029).
import type { Lang } from '@dool2/i18n'

const ko = {
  noPlatform: '이 컴퓨터에서는 두리 브라우저를 쓸 수 없어요',
  offline: '인터넷 연결을 확인해 주세요. 브라우저 파일을 받을 곳에 닿지 않았어요',
  serverDown: (status: number) => `브라우저 파일을 주는 서버가 응답하지 않았어요 (${status})`,
  partial: '브라우저 파일이 다 받아지지 않았어요. 다시 해 주세요',
  checksum: '받은 브라우저 파일이 원래 파일과 달라요. 안전을 위해 설치를 멈췄어요',
  extractFailed: '받은 브라우저 파일을 풀지 못했어요',
  notFoundAfter: '브라우저를 받았는데 실행 파일을 찾지 못했어요. 다시 해 주세요',
  installFailed: (err: string) => `두리 브라우저를 준비하지 못했어요: ${err}`,
}

const en: typeof ko = {
  noPlatform: "Dool2's browser isn't available on this computer",
  offline: "Check your internet connection. Couldn't reach the server with the browser files",
  serverDown: (status) => `The server with the browser files didn't respond (${status})`,
  partial: "The browser files didn't finish downloading. Please try again",
  checksum: "The downloaded browser files don't match the original. Install stopped to keep you safe",
  extractFailed: "Couldn't unpack the downloaded browser files",
  notFoundAfter: "The browser was downloaded, but its program can't be found. Please try again",
  installFailed: (err) => `Couldn't get Dool2's browser ready: ${err}`,
}

export type ChromiumText = typeof ko
export const CHROMIUM_TEXT: Record<Lang, ChromiumText> = { ko, en }
