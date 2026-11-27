// Browser tool text people read: approval cards, phone cards and notices (ADR 0029).
// Korean is the reference and must stay exactly as before; English has the same keys.
import { messages } from '@dool2/i18n'

/** Values for the "files put into a field" message */
export interface UploadedInfo {
  host: string
  label: string
  names: string
  chooser: boolean
  accept: string
  off: string
}

export const browserText = messages({
  ko: {
    dialogReason: (word: string) => `확인 창의 "${word}"`,
    subInstallment: '할부',
    subCard: '카드',
    subBank: '은행',
    shipWarn: '내 정보 주소와 달라요. 받는 곳을 확인해 주세요',
    myAddress: (home: string) => `내 정보 주소 · ${home}`,
    payWhat: '결제',
    payMethodTitle: '결제 수단',
    rrnBack: '주민등록번호 뒷자리',
    payPin: '결제 비밀번호',
    codeLabel: '인증번호',
    tapSay: '그림에서 맞는 곳을 눌러 주세요',
    authBody: '폰의 인증 앱에서 승인해 주세요',
    authTitle: '인증 앱에서 승인해 주세요',
    authTitleApp: (app: string) => `${app}에서 승인해 주세요`,
    authBodySite: (site: string) => `${site} 본인 확인이에요. 승인하면 바로 이어서 할게요.`,
    authExpiredTitle: '인증 시간이 지났어요',
    authExpiredBody: '다시 하려면 두리에게 "다시 해 줘"라고 해 주세요',
    authHint: '인증 앱에 온 알림에서 승인한 다음, 아래 버튼을 눌러 주세요.',
    authHintApp: (app: string) => `${app}에 온 알림에서 승인한 다음, 아래 버튼을 눌러 주세요.`,
    reasonPayCard: '결제 카드',
    reasonToolTier: '서비스 도구 등급',
    reasonConsent: (name: string) => `"${name}" (내 정보 이용 동의)`,
    reasonAiAsked: 'AI가 승인을 요청한 버튼',
    allOf: (n: number) => `[${n}개 모두] `,
    reasonUpload: '내 PC 파일을 웹사이트에 올리는 일',
    uploadWhat: (n: number, names: string) => `파일 ${n}개 올리기 · ${names}`,
    uploaded: (u: UploadedInfo) =>
      `${u.host}의 ${u.label ? `"${u.label}" ` : ''}파일 칸에 ${u.names}을(를) 넣었어요` +
      `${u.chooser ? ' (눌러서 뜬 파일 고르기 창으로)' : ''}.` +
      (u.off ? ` 이 칸은 "${u.accept}"만 받는다고 적혀 있어요: ${u.off}은(는) 거절될 수 있어요.` : '') +
      ' 아직 글 올리기·제출은 하지 않았어요. 사이트가 파일을 받는 데 시간이 걸릴 수 있으니 화면에서 올라간 것(미리보기·파일 이름·진행률)을 확인하고 이어서 해요.',
    uploadChanged: (what: string) =>
      `승인한 뒤 화면이 바뀌어서 파일을 넣지 않았어요("${what}"). 페이지를 다시 읽고 다시 올려 주세요.`,
    filesUnavailable: '파일을 볼 수 없어요',
    uploadFailed: (err: string) => `파일을 올리지 못했어요: ${err}`,
    reasonAiDialog: 'AI가 승인을 요청한 확인 창',
    dialogRole: '확인 창',
    dialogLabel: (message: string) => `확인 — ${message}`,
    payFailed: (reason: string) => `결제를 마치지 못했어요${reason ? `: ${reason}` : ''}`,
    orderDone: (no: string, summary: string) => `주문 완료 · 주문번호 ${no}${summary ? ` · ${summary}` : ''}`,
    remoteViewOnly: '이 탭은 원격 화면으로 볼 수 없어요 (두리가 넘긴 탭만, 30분 동안)',
    remoteControlOnly: '이 탭은 원격으로 다룰 수 없어요 (두리가 넘긴 탭만, 30분 동안)',
    tapOutside: '누른 자리가 화면 밖이에요',
    approvalGone: '이미 처리했거나 시간이 지난 승인 요청이에요',
    paying: (tabId: number, extra: number[]) =>
      `결제가 시작됐어요. 이제 할 일은 주문 완료 화면까지 결제를 마치는 거예요. 결제 묶음: 탭 ${tabId}(주문서)` +
      `${extra.map((t) => `·탭 ${t}(결제 창)`).join('')}. ` +
      '결제 회사 창의 카드 선택·[다음]·[동의]·[결제하기]는 다시 승인받지 않고 눌러요(결제 비밀번호는 browser_request_code kind "pin", 인증 앱 승인은 browser_wait_auth). ' +
      '결제 창이 안 보이면 browser_read로 화면 안 액자나 새 탭을 찾아요(늦게 뜬 창도 두리가 묶음에 넣어요). 이 탭들은 결제가 끝날 때까지 다른 주소로 옮기지 않아요. ' +
      '주문 완료 화면에서 주문번호를 읽으면 browser_order_done(tabId, order_no)을 불러요. 결제가 안 되면 browser_order_done(failed: true, reason)으로 알리고 다른 길을 찾아요.',
    dialogPressed: (text: string) => `확인 창 "${text}"에서 [확인]을 눌렀어요.`,
    screenNow: (title: string, url: string) => `지금 화면: ${title} (${url})`,
    dialogFailed: (err: string) => `확인 창의 [확인]을 누르지 못했어요: ${err}`,
    changedAfterApproval: (label: string) =>
      `승인한 뒤 화면이 바뀌어서 "${label}" 버튼을 누르지 않았어요. 페이지를 다시 확인해 주세요.`,
    newAddress: (address: string) => `새 주소 ${address}`,
    shipChange: (shipTo: string, pay: string, label: string) =>
      `사용자가 승인하면서 받는 곳을 "${shipTo}"(으)로 바꿔 달라고 했어요. 아직 결제는 누르지 않았어요. ` +
      `화면의 배송지 변경으로 그곳을 고른 뒤(새 주소면 배송지 추가로 넣고, 받는 사람·연락처는 browser_fill_profile로)${pay ? ` 결제 수단 ${pay}을(를) 고르고` : ''} [${label}]을(를) browser_click으로 누르세요. 이번 결제는 이미 승인돼 다시 묻지 않아요(1시간 안, 한 번). 누른 뒤에는 결제 창까지 끝내고 주문 완료 화면의 주문번호로 browser_order_done을 불러요.`,
    payFail: (why: string) => `${why} 결제는 하지 않았어요. 페이지를 다시 읽고 승인을 다시 받아 주세요.`,
    failNoMethod: '고른 결제 수단을 찾을 수 없어요.',
    chosenMethod: '고른 결제 수단',
    choiceChanged: (what: string) => `"${what}" 칸이 화면에서 바뀌었어요.`,
    choiceMoved: (what: string) => `"${what}"을(를) 고르자 다른 화면으로 넘어갔어요.`,
    subMissing: '고른 카드·할부를 찾을 수 없어요.',
    subGone: (label: string, title?: string) =>
      `"${label}"을(를) 고를 ${title ?? '칸'} 목록이 화면에서 사라졌어요.`,
    subMoved: '카드·할부를 고르자 다른 화면으로 넘어갔어요.',
    finalChanged: (label: string) => `고르고 나니 마지막 버튼("${label}")이 바뀌었어요.`,
    alsoConfirmed: (asked: string) => ` 사이트가 확인 창("${asked}")을 띄워 [확인]도 눌렀어요.`,
    noEffect: (label: string, coveredBy?: string) =>
      `"${label}" 버튼을 눌렀는데 화면이 그대로예요` +
      (coveredBy ? ` ("${coveredBy}"이(가) 그 자리를 덮고 있었어요)` : '') +
      '. 결제 창도 새 화면도 뜨지 않았어요. 페이지를 읽어 무엇이 막는지(덮은 창·빈 필수 칸·안내 문구) 확인하고, 고친 뒤 다시 승인을 받아 주세요.',
    methodPicked: (name: string) => `결제 수단 "${name}"`,
    innerHint: (kind: string, inner: string) =>
      ` 사용자가 등록한 ${kind} 결제 수단은 "${inner}"이에요. 결제 창에서 고를 수 있으면 그걸 고르고, 결제 비밀번호는 browser_request_code(kind: "pin")로 폰 키패드, 본인 확인은 browser_wait_auth로 받아요.`,
    seriesRest: (many: number) =>
      ` 사용자가 ${many}개 모두 승인했어요: 남은 ${many - 1}개는 같은 버튼을 승인 요청 없이 browser_click으로 이어서 눌러요(10분 안).`,
    pressedButton: (how: string, name: string, also: string) =>
      `${how ? `${how}을(를) 고르고 ` : ''}"${name}" 버튼을 눌렀어요.${also}`,
    pressFailed: (label: string, err: string) => `"${label}" 버튼을 누르지 못했어요: ${err}`,
  },
  en: {
    dialogReason: (word: string) => `"${word}" in the confirm dialog`,
    subInstallment: 'Installment',
    subCard: 'Card',
    subBank: 'Bank',
    shipWarn: 'Different from your saved address. Check where it goes',
    myAddress: (home: string) => `Saved address · ${home}`,
    payWhat: 'Payment',
    payMethodTitle: 'Payment method',
    rrnBack: 'Resident registration number (back digits)',
    payPin: 'Payment PIN',
    codeLabel: 'Verification code',
    tapSay: 'Tap the right spot in the image',
    authBody: 'Approve it in the authenticator app on your phone',
    authTitle: 'Approve it in your authenticator app',
    authTitleApp: (app: string) => `Approve it in ${app}`,
    authBodySite: (site: string) => `It's the identity check for ${site}. Once you approve, I'll carry on.`,
    authExpiredTitle: 'Verification timed out',
    authExpiredBody: 'To try again, tell Dool2 "do it again"',
    authHint: 'Approve the notification in your authenticator app, then tap the button below.',
    authHintApp: (app: string) => `Approve the notification from ${app}, then tap the button below.`,
    reasonPayCard: 'Payment card',
    reasonToolTier: 'Service tool tier',
    reasonConsent: (name: string) => `"${name}" (consent to use my info)`,
    reasonAiAsked: 'A button the AI asked approval for',
    allOf: (n: number) => `[all ${n}] `,
    reasonUpload: 'Uploads files from my PC to a website',
    uploadWhat: (n: number, names: string) => `Upload ${n} ${n === 1 ? 'file' : 'files'} · ${names}`,
    uploaded: (u: UploadedInfo) =>
      `Put ${u.names} in the ${u.label ? `"${u.label}" ` : ''}file field on ${u.host}` +
      `${u.chooser ? ' (through the file picker that opened on click)' : ''}.` +
      (u.off ? ` This field says it takes only "${u.accept}": ${u.off} may be rejected.` : '') +
      ' Nothing is posted or submitted yet. The site may take a while to receive the files, so check on screen what went up (preview, file name, progress) and carry on.',
    uploadChanged: (what: string) =>
      `The screen changed after approval, so the files were not put in ("${what}"). Read the page again and upload again.`,
    filesUnavailable: 'Cannot read the files',
    uploadFailed: (err: string) => `Could not upload the files: ${err}`,
    reasonAiDialog: 'A confirm dialog the AI asked approval for',
    dialogRole: 'Confirm dialog',
    dialogLabel: (message: string) => `OK — ${message}`,
    payFailed: (reason: string) => `Could not finish the payment${reason ? `: ${reason}` : ''}`,
    orderDone: (no: string, summary: string) =>
      `Order complete · Order number ${no}${summary ? ` · ${summary}` : ''}`,
    remoteViewOnly: 'This tab cannot be viewed remotely (only tabs Dool2 handed to you, for 30 minutes)',
    remoteControlOnly:
      'This tab cannot be controlled remotely (only tabs Dool2 handed to you, for 30 minutes)',
    tapOutside: 'That spot is outside the screen',
    approvalGone: 'This approval was already handled or has expired',
    paying: (tabId: number, extra: number[]) =>
      `Payment has started. The task now is to finish paying until the order complete screen. Payment group: tab ${tabId} (order sheet)` +
      `${extra.map((t) => `·tab ${t} (payment window)`).join('')}. ` +
      'Press card choice, [next], [agree] and [pay] in the payment company window without asking approval again (payment PIN with browser_request_code kind "pin", authenticator approval with browser_wait_auth). ' +
      'If the payment window is not visible, look for a frame on the page or a new tab with browser_read (Dool2 adds late windows to the group too). These tabs are not moved to another URL until the payment finishes. ' +
      'When you read the order number on the order complete screen, call browser_order_done(tabId, order_no). If the payment fails, report it with browser_order_done(failed: true, reason) and find another way.',
    dialogPressed: (text: string) => `Pressed [OK] in the confirm dialog "${text}".`,
    screenNow: (title: string, url: string) => `Screen now: ${title} (${url})`,
    dialogFailed: (err: string) => `Could not press [OK] in the confirm dialog: ${err}`,
    changedAfterApproval: (label: string) =>
      `The screen changed after approval, so the "${label}" button was not pressed. Check the page again.`,
    newAddress: (address: string) => `New address ${address}`,
    shipChange: (shipTo: string, pay: string, label: string) =>
      `While approving, the user asked to change the delivery address to "${shipTo}". Payment is not pressed yet. ` +
      `Choose it with the address change on screen (for a new address, add it as a new address, and fill recipient and contact with browser_fill_profile)${pay ? `, choose the payment method ${pay},` : ''} then press [${label}] with browser_click. This payment is already approved, so it is not asked again (within 1 hour, once). After pressing, finish through the payment window and call browser_order_done with the order number on the order complete screen.`,
    payFail: (why: string) => `${why} Nothing was paid. Read the page again and get approval again.`,
    failNoMethod: 'Cannot find the chosen payment method.',
    chosenMethod: 'chosen payment method',
    choiceChanged: (what: string) => `The "${what}" option changed on screen.`,
    choiceMoved: (what: string) => `Choosing "${what}" moved to another screen.`,
    subMissing: 'Cannot find the chosen card or installment.',
    subGone: (label: string, title?: string) =>
      `The ${title ?? 'option'} list for "${label}" disappeared from the screen.`,
    subMoved: 'Choosing the card or installment moved to another screen.',
    finalChanged: (label: string) => `After choosing, the final button ("${label}") changed.`,
    alsoConfirmed: (asked: string) =>
      ` The site showed a confirm dialog ("${asked}"), so [OK] was pressed too.`,
    noEffect: (label: string, coveredBy?: string) =>
      `Pressed the "${label}" button, but the screen did not change` +
      (coveredBy ? ` ("${coveredBy}" was covering that spot)` : '') +
      '. No payment window or new screen appeared. Read the page to see what blocks it (a covering window, an empty required field, a notice), fix it, then get approval again.',
    methodPicked: (name: string) => `payment method "${name}"`,
    innerHint: (kind: string, inner: string) =>
      ` The user's registered ${kind} payment method is "${inner}". If it can be chosen in the payment window, choose it; get the payment PIN with browser_request_code(kind: "pin") on the phone keypad and identity checks with browser_wait_auth.`,
    seriesRest: (many: number) =>
      ` The user approved all ${many}: press the same button for the remaining ${many - 1} with browser_click without asking approval (within 10 minutes).`,
    pressedButton: (how: string, name: string, also: string) =>
      `${how ? `Chose ${how} and pressed` : 'Pressed'} the "${name}" button.${also}`,
    pressFailed: (label: string, err: string) => `Could not press the "${label}" button: ${err}`,
  },
})
