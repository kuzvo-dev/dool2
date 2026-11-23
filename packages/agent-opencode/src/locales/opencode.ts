// Pay-as-you-go mode (OpenCode) status, install and error text people see in the apps (ADR 0029).
import type { Lang } from '@dool2/i18n'

const ko = {
  notReady: '종량제 모드를 아직 준비하지 않았어요',
  needKey: 'API 키를 넣어 주세요',
  stopped: '멈췄어요',
  badKey: 'API 키가 맞지 않아요. 설정에서 키를 다시 넣어 주세요',
  noCredit: 'AI 제공자 계정의 잔액이나 한도가 부족해요. 제공자 사이트에서 확인해 주세요',
  tooMany: '요청이 너무 많아 잠시 쉬어야 해요',
  noAnswer: (msg: string) => `AI가 답하지 못했어요${msg ? `: ${msg}` : ''}`,
  unsafeTool: (name: string) => `두리 도구가 아닌 도구를 쓰려 해서 멈췄어요: ${name}`,
  // install
  extractFailed: '압축을 풀지 못했어요',
  noPlatform: '이 컴퓨터에서는 종량제 모드를 쓸 수 없어요',
  offline: '인터넷 연결을 확인해 주세요',
  downloadFailed: (status?: number) => `내려받지 못했어요${status !== undefined ? ` (${status})` : ''}`,
  noChecksum: '설치 파일의 확인값을 찾지 못했어요',
  checksum: '받은 파일이 공식 파일과 달라요. 안전을 위해 설치를 멈췄어요',
  notFoundAfter: '설치했는데 실행 파일을 찾지 못했어요',
  installFailed: (err: string) => `설치하지 못했어요: ${err}`,
  // model picker
  recommended: '추천',
  cheap: '저렴',
  smartest: '가장 똑똑함',
  openRouter: 'OpenRouter (여러 회사 모델)',
}

const en: typeof ko = {
  notReady: "Pay-as-you-go mode isn't set up yet",
  needKey: 'Add an API key',
  stopped: 'Stopped',
  badKey: "The API key doesn't work. Enter it again in Settings",
  noCredit: 'Your AI provider account is out of credit or over its limit. Check on the provider site',
  tooMany: 'Too many requests. It needs a short break',
  noAnswer: (msg) => `The AI couldn't answer${msg ? `: ${msg}` : ''}`,
  unsafeTool: (name) => `Stopped because it tried to use a tool other than Dool2's: ${name}`,
  extractFailed: "Couldn't unpack the download",
  noPlatform: "Pay-as-you-go mode doesn't run on this computer",
  offline: 'Check your internet connection',
  downloadFailed: (status) => `Couldn't download${status !== undefined ? ` (${status})` : ''}`,
  noChecksum: "Couldn't find the installer's checksum",
  checksum: "The downloaded file doesn't match the official one. Install stopped to keep you safe",
  notFoundAfter: "Installed, but the program can't be found",
  installFailed: (err) => `Couldn't install: ${err}`,
  recommended: 'recommended',
  cheap: 'low cost',
  smartest: 'smartest',
  openRouter: 'OpenRouter (models from many companies)',
}

export type OpenCodeText = typeof ko
export const OPENCODE_TEXT: Record<Lang, OpenCodeText> = { ko, en }
