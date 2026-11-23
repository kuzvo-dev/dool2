// Codex status, install and error text people see in the apps (ADR 0029).
import type { Lang } from '@dool2/i18n'

const ko = {
  notDownloaded: 'Codex를 아직 받지 않았어요',
  notFound: 'Codex를 찾지 못했어요',
  needLogin: 'ChatGPT 로그인이 필요해요',
  statusFailed: (err: string) => `Codex 상태를 확인하지 못했어요: ${err}`,
  loginFirst: 'ChatGPT 로그인이 필요해요. PC에서 로그인해 주세요.',
  loginAgain: 'ChatGPT 로그인이 필요해요. PC에서 다시 로그인해 주세요.',
  stopped: '멈췄어요',
  unfinished: (msg: string) => `Codex가 일을 끝내지 못했어요${msg ? `: ${msg}` : ''}`,
  limit: 'ChatGPT 사용량이 다 찼어요. 한도가 풀리면 다시 할게요.',
  unsafeItem: (type: string) => `두리 도구가 아닌 기능(${type})을 쓰려고 해서 멈췄어요`,
  unsafeTool: (name: string) => `두리 도구가 아닌 도구(${name})를 쓰려고 해서 멈췄어요`,
  // install
  extractFailed: '압축을 풀지 못했어요',
  noPlatform: '이 컴퓨터에서는 Codex를 쓸 수 없어요',
  offline: '인터넷 연결을 확인해 주세요',
  downloadFailed: (status: number) => `Codex를 내려받지 못했어요 (${status})`,
  checksum: '받은 파일이 공식 파일과 달라요. 안전을 위해 설치를 멈췄어요',
  notInArchive: '받은 파일에서 Codex를 찾지 못했어요',
  notFoundAfter: '설치했는데 Codex를 찾지 못했어요',
  installFailed: (err: string) => `Codex를 설치하지 못했어요: ${err}`,
}

const en: typeof ko = {
  notDownloaded: "Codex isn't downloaded yet",
  notFound: "Couldn't find Codex",
  needLogin: 'Sign in to ChatGPT',
  statusFailed: (err) => `Couldn't check Codex: ${err}`,
  loginFirst: 'Sign in to ChatGPT on the PC.',
  loginAgain: 'Sign in to ChatGPT again on the PC.',
  stopped: 'Stopped',
  unfinished: (msg) => `Codex couldn't finish${msg ? `: ${msg}` : ''}`,
  limit: "You've hit the ChatGPT usage limit. I'll pick it up again when it resets.",
  unsafeItem: (type) => `Stopped because it tried to use something other than Dool2 tools (${type})`,
  unsafeTool: (name) => `Stopped because it tried to use a tool other than Dool2's (${name})`,
  extractFailed: "Couldn't unpack the download",
  noPlatform: "Codex doesn't run on this computer",
  offline: 'Check your internet connection',
  downloadFailed: (status) => `Couldn't download Codex (${status})`,
  checksum: "The downloaded file doesn't match the official one. Install stopped to keep you safe",
  notInArchive: "Couldn't find Codex in the download",
  notFoundAfter: "Installed, but Codex can't be found",
  installFailed: (err) => `Couldn't install Codex: ${err}`,
}

export type CodexText = typeof ko
export const CODEX_TEXT: Record<Lang, CodexText> = { ko, en }
