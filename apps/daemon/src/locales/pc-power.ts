// Text people read for lock screen / sleep approval cards (ADR 0029). Korean is the reference copy
export const PC_POWER_TEXT = {
  ko: {
    lock: '화면 잠그기',
    sleep: '잠자기',
    slowLock: (sec: number) =>
      `이 맥은 화면이 꺼지고 ${sec}초 뒤부터 암호를 물어요(시스템 설정 > 잠금 화면에서 "즉시"로 바꿀 수 있어요)`,
  },
  en: {
    lock: 'Lock screen',
    sleep: 'Sleep',
    slowLock: (sec: number) =>
      `This Mac asks for the password only ${sec} seconds after the screen turns off (you can change it to "Immediately" in System Settings > Lock Screen)`,
  },
} as const
