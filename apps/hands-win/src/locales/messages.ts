// User-facing messages the Windows PC-app helper returns (ADR 0029: Korean copy lives in a locale file, code is
// English). These are the `error` strings of a failed command and the refusal reasons, written in the Dool2 persona —
// a tool result says what happened and what the user can do, never "stop". They mirror @dool2/hands-mac's wording.
export const MSG = {
  noApp: '어떤 앱인지 알려 주세요',
  noAppArg: '어떤 앱인지 알려 주세요(bundleId)',
  blockedApp: (app: string): string => `이 앱(${app})은 화면 제어로 다루지 않아요`,
  unknownCommand: (cmd: string): string => `모르는 명령이에요: ${cmd}`,
  unknownModifier: (mod: string): string => `모르는 보조 키예요: ${mod}`,
  noWindow: '이 앱에 열린 창이 없어요',
  refNotFound: (ref: string): string => `${ref}를 찾지 못했어요. 화면을 다시 읽어(screen_read) 주세요`,
  noClickTarget: '누를 곳(ref 또는 x·y)이 없어요',
  noText: '넣을 글자가 없어요',
  noKey: '누를 키가 없어요',
  passwordRefused: '비밀번호 칸에는 넣지 않아요. 사용자에게 넘겨 주세요',
  // Destructive key-combo refusals.
  altF4: 'Alt+F4로 앱을 닫지 않아요',
  metaKey: '윈도우 키 단축키는 쓰지 않아요(시스템 전체에 영향을 줘요)',
  taskManager: '작업 관리자 단축키는 쓰지 않아요',
  secureAttention: '보안 화면 단축키는 쓰지 않아요',
  // JSON protocol errors.
  badJson: '잘못된 JSON이에요',
  notAnObject: '명령 객체가 아니에요',
  noCmd: 'cmd가 없어요',
} as const
