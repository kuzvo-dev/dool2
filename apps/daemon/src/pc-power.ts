// PC 화면 잠그기·잠자기 (ADR 0024 추가). 승인한 뒤 바로 한다. 끄기는 만들지 않는다(저장 안 된 작업이 사라질 수 있어서).
// - 맥: 잠그기 = 화면 끄기(pmset displaysleepnow) + "화면이 꺼지면 바로 암호 요구" 설정 확인(sysadminctl -screenLock status),
//   잠자기 = pmset sleepnow. 둘 다 관리자 권한이 필요 없다
// - 윈도우: 잠그기 = LockWorkStation, 잠자기 = SetSuspendState(대기)
import type { Exec } from './file-ops.js'

export type PowerAction = 'lock' | 'sleep'

export const POWER_LABEL: Record<PowerAction, string> = { lock: '화면 잠그기', sleep: '잠자기' }

/** 맥의 잠금 암호 설정: 'immediate' | 초 | 'off' | undefined(모름) */
export function parseScreenLock(out: string): 'immediate' | 'off' | number | undefined {
  if (/screenLock delay is immediate/i.test(out)) return 'immediate'
  const n = /screenLock delay is (\d+) seconds?/i.exec(out)?.[1]
  if (n) return Number(n)
  if (/screenLock is off/i.test(out)) return 'off'
  return undefined
}

/** 하기 전에 확인: 못 하면 이유, 하면 승인 카드에 적을 알아 둘 것(없을 수 있음) */
export async function powerCheck(
  action: PowerAction,
  platform: NodeJS.Platform,
  exec: Exec,
): Promise<{ ok: false; why: string } | { ok: true; note?: string }> {
  if (platform === 'win32') return { ok: true }
  if (platform !== 'darwin') return { ok: false, why: '이 PC에서는 아직 못 해요(맥·윈도우만).' }
  if (action === 'sleep') return { ok: true }
  const r = await exec('sysadminctl', ['-screenLock', 'status'], { timeout: 10_000 })
  const v = parseScreenLock(`${r.stdout}\n${r.stderr}`)
  if (v === 'off')
    return {
      ok: false,
      why: '이 맥은 화면이 꺼져도 암호를 묻지 않게 돼 있어 잠글 수 없어요. 시스템 설정 > 잠금 화면 > "화면 보호기 시작 또는 디스플레이가 꺼진 후 암호 요구"를 "즉시"로 바꿔 달라고 안내해 주세요. 잠자기(sleep)는 할 수 있어요.',
    }
  if (typeof v === 'number' && v > 5)
    return {
      ok: true,
      note: `이 맥은 화면이 꺼지고 ${v}초 뒤부터 암호를 물어요(시스템 설정 > 잠금 화면에서 "즉시"로 바꿀 수 있어요)`,
    }
  return { ok: true }
}

/** 실제로 하기 */
export async function powerDo(
  action: PowerAction,
  platform: NodeJS.Platform,
  exec: Exec,
): Promise<string | undefined> {
  const r =
    platform === 'win32'
      ? action === 'lock'
        ? await exec('rundll32.exe', ['user32.dll,LockWorkStation'])
        : await exec('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)",
          ])
      : await exec('pmset', [action === 'lock' ? 'displaysleepnow' : 'sleepnow'])
  return r.code === 0 ? undefined : r.stderr.split('\n')[0]?.slice(0, 160) || '하지 못했어요'
}

/** 끄기 부탁에 돌려줄 다음 길 */
export const POWER_OFF_TEXT =
  'PC 끄기는 두리가 하지 않아요(열려 있는 문서·저장 안 된 작업이 사라질 수 있어서). 대신 잠자기(action: "sleep")를 권해 주세요: 전기는 거의 안 쓰고, 다시 열면 하던 그대로예요. 꼭 꺼야 하면 저장한 뒤 직접 꺼 달라고 알려 주세요.'
