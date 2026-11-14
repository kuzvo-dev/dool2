// 늘 깨어 있기 (docs/architecture.md 7.1). 사용자가 허락한 설정만 바꾼다.
// - 일하는 동안 잠들지 않기: 시스템만 깨어 있고 화면은 꺼져도 된다 (관리자 권한 필요 없음)
// - PC를 켜면 두리 자동 시작: 로그인 항목에 창 없이 등록
// 화면 잠금, 자동 로그인, 디스크 암호화 같은 보안 설정은 건드리지 않는다.
import type { Settings } from '@dool2/protocol'

export interface PowerApi {
  start(): number
  stop(id: number): void
}

/** 지금 PC가 잠들지 않게 막아야 하는지 */
export function shouldKeepAwake(settings: Pick<Settings, 'keepAwake'>, busy: boolean): boolean {
  if (settings.keepAwake === 'always') return true
  if (settings.keepAwake === 'working') return busy
  return false
}

/** 설정과 일하는 상태가 바뀔 때마다 잠자기 막기를 켜고 끈다 */
export class KeepAwake {
  private id: number | undefined

  constructor(private readonly power: PowerApi) {}

  get active() {
    return this.id !== undefined
  }

  update(settings: Pick<Settings, 'keepAwake'>, busy: boolean) {
    const want = shouldKeepAwake(settings, busy)
    if (want && this.id === undefined) this.id = this.power.start()
    if (!want && this.id !== undefined) {
      this.power.stop(this.id)
      this.id = undefined
    }
  }
}

/** 로그인 항목 설정값. 자동 시작일 때는 창 없이(트레이로) 켠다 */
export function loginItemSettings(settings: Pick<Settings, 'launchAtLogin'>) {
  return { openAtLogin: settings.launchAtLogin === true, openAsHidden: true, args: ['--hidden'] }
}
