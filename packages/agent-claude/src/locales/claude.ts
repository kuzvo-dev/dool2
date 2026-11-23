// Claude Code status, install, login and error text people see in the apps (ADR 0029).
import type { Lang } from '@dool2/i18n'

const ko = {
  notInstalled: 'Claude Code가 설치돼 있지 않아요',
  needLogin: 'Claude 로그인이 필요해요',
  statusFailed: (err: string) => `Claude Code 상태를 확인하지 못했어요: ${err}`,
  stopped: '멈췄어요',
  crashed: (code: number | null, tail: string) =>
    `Claude Code가 중간에 멈췄어요 (종료 코드 ${code})${tail ? `: ${tail}` : ''}`,
  toolsUnsafe: (tools: string) => `두리 도구가 아닌 도구가 켜져 있어서 멈췄어요: ${tools}`,
  loginAgain: 'Claude 로그인이 필요해요. PC에서 다시 로그인해 주세요.',
  unfinished: (text: string) => `Claude Code가 일을 끝내지 못했어요${text ? `: ${text}` : ''}`,
  limit: 'Claude 사용량이 다 찼어요. 한도가 풀리면 다시 할게요.',
  // install
  noPlatform: '이 컴퓨터에서는 Claude Code를 쓸 수 없어요',
  offline: '인터넷 연결을 확인해 주세요. Claude 배포 서버에 닿지 않았어요',
  serverDown: (status: number) => `Claude 배포 서버가 응답하지 않았어요 (${status})`,
  noVersion: '최신 버전을 확인하지 못했어요. 이 지역에서 Claude를 쓸 수 없는 경우일 수 있어요',
  noFile: '이 컴퓨터에 맞는 설치 파일을 찾지 못했어요',
  noDownload: '설치 파일을 받지 못했어요',
  partial: '설치 파일이 다 받아지지 않았어요. 다시 해 주세요',
  checksum: '받은 파일이 공식 파일과 달라요. 안전을 위해 설치를 멈췄어요',
  finishFailed: (code: number) => `설치를 마무리하지 못했어요 (종료 코드 ${code})`,
  notFoundAfter: '설치했는데 Claude Code를 찾지 못했어요. 컴퓨터를 다시 켠 뒤 확인해 주세요',
  installFailed: (err: string) => `설치하지 못했어요: ${err}`,
  // login
  loginTimeout: '시간이 지나서 로그인을 멈췄어요. 다시 해 주세요.',
  loginNoWindow: '로그인 창을 열지 못했어요. 잠시 뒤 다시 해 주세요.',
  loginUnfinished: '로그인이 끝나지 않았어요. 다시 해 주세요.',
}

const en: typeof ko = {
  notInstalled: 'Claude Code is not installed',
  needLogin: 'Sign in to Claude',
  statusFailed: (err) => `Couldn't check Claude Code: ${err}`,
  stopped: 'Stopped',
  crashed: (code, tail) => `Claude Code stopped partway (exit code ${code})${tail ? `: ${tail}` : ''}`,
  toolsUnsafe: (tools) => `Stopped because tools other than Dool2's were turned on: ${tools}`,
  loginAgain: 'Sign in to Claude again on the PC.',
  unfinished: (text) => `Claude Code couldn't finish${text ? `: ${text}` : ''}`,
  limit: "You've hit the Claude usage limit. I'll pick it up again when it resets.",
  noPlatform: "Claude Code doesn't run on this computer",
  offline: "Check your internet connection. Couldn't reach the Claude download server",
  serverDown: (status) => `The Claude download server didn't respond (${status})`,
  noVersion: "Couldn't check the latest version. Claude may not be available in this region",
  noFile: "Couldn't find an installer for this computer",
  noDownload: "Couldn't download the installer",
  partial: "The installer didn't finish downloading. Please try again",
  checksum: "The downloaded file doesn't match the official one. Install stopped to keep you safe",
  finishFailed: (code) => `Couldn't finish installing (exit code ${code})`,
  notFoundAfter: "Installed, but Claude Code can't be found. Restart the computer and check again",
  installFailed: (err) => `Couldn't install: ${err}`,
  loginTimeout: 'Sign-in timed out. Please try again.',
  loginNoWindow: "Couldn't open the sign-in window. Try again in a moment.",
  loginUnfinished: "Sign-in didn't finish. Please try again.",
}

export type ClaudeText = typeof ko
export const CLAUDE_TEXT: Record<Lang, ClaudeText> = { ko, en }
