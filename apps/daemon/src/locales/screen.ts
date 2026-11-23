// PC screen control copy people read: approval cards and approval results on the phone (ADR 0029)
import { messages } from '@dool2/i18n'
import { josa } from '@dool2/protocol/rich'

export const screenCopy = messages({
  ko: {
    appRole: '앱',
    keyRole: '키',
    firstApp: '처음 다루는 앱',
    mayControl: (name: string) => `두리가 ${josa(name, '을/를')} 조작해도 될까요?`,
    purpose: (why: string) => `하려는 일: ${why}`,
    enterSends: '메신저에서 Enter(보내기)',
    pressIn: (app: string, label: string) => `${app}에서 "${label}" 누르기`,
    gone: '이미 처리했거나 시간이 지난 승인 요청이에요',
    allowed: (name: string) => `${josa(name, '을/를')} 두리가 조작하도록 허용했어요.`,
    pressedEnter: (where: string) => `${where}에서 Enter를 눌렀어요.`,
    changed: (label: string) =>
      `승인한 뒤 화면이 바뀌어서 "${label}" 버튼을 누르지 않았어요. 화면을 다시 확인해 주세요.`,
    pressed: (where: string, label: string) => `${where}의 "${label}" 버튼을 눌렀어요.`,
    failed: (label: string, error: string) => `"${label}"을(를) 하지 못했어요: ${error}`,
    unavailable: '이 PC에서는 아직 PC 화면 제어를 쓸 수 없어요 (지금은 맥만 돼요).',
    locked:
      'PC 화면이 잠겨 있어서 앱을 다룰 수 없어요. 사용자에게 PC 잠금을 풀어 달라고 부탁하고 이번 답을 끝내세요.',
    permissionOff: (screen: boolean) =>
      `맥의 ${screen ? '"화면 기록"' : '"손쉬운 사용"'} 권한이 꺼져 있어요. 사용자에게 두리 설정 → PC 앱 조작에서 [권한 켜기]를 눌러 달라고 부탁하고 이번 답을 끝내세요.`,
  },
  en: {
    appRole: 'App',
    keyRole: 'Key',
    firstApp: 'An app Dool2 has not used before',
    mayControl: (name: string) => `Can Dool2 control ${name}?`,
    purpose: (why: string) => `What it wants to do: ${why}`,
    enterSends: 'Enter in a messenger (sends)',
    pressIn: (app: string, label: string) => `Press "${label}" in ${app}`,
    gone: 'This approval was already handled or has expired',
    allowed: (name: string) => `Dool2 can now control ${name}.`,
    pressedEnter: (where: string) => `Pressed Enter in ${where}.`,
    changed: (label: string) =>
      `The screen changed after approval, so the "${label}" button was not pressed. Please check the screen again.`,
    pressed: (where: string, label: string) => `Pressed the "${label}" button in ${where}.`,
    failed: (label: string, error: string) => `Couldn't do "${label}": ${error}`,
    unavailable: "PC screen control isn't available on this PC yet (Mac only for now).",
    locked: "The PC screen is locked, so apps can't be controlled. Unlock the PC and try again.",
    permissionOff: (screen: boolean) =>
      `The Mac ${screen ? '"Screen Recording"' : '"Accessibility"'} permission is off. Turn it on in Dool2 settings → PC app control with [Turn on permission].`,
  },
})
