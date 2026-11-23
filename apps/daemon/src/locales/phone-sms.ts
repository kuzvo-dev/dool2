// 문자 보내기(내 폰 번호로) 화면 문구. 한국어가 기준이고 영어는 키가 같아야 한다 (ADR 0029)
export const PHONE_SMS_TEXT = {
  ko: {
    role: '문자',
    reason: '다른 사람에게 문자를 보내요',
    where: '내 폰 문자',
    cancel: '보낸 문자는 되돌릴 수 없어요',
    gone: '이미 처리했거나 시간이 지난 승인 요청이에요',
    phoneOnly:
      '문자는 폰에서 승인해야 보낼 수 있어요. 폰의 승인 카드에서 받는 사람을 확인하고 승인해 주세요.',
    noResult:
      '폰에서 승인은 받았지만 보낸 결과가 오지 않았어요. 폰 앱을 새 판으로 업데이트했는지 확인해 주세요.',
  },
  en: {
    role: 'Text',
    reason: 'Sends a text message to someone',
    where: 'My phone (SMS)',
    cancel: 'A sent text cannot be taken back',
    gone: 'This approval was already handled or has expired',
    phoneOnly:
      'Texts can only be approved on the phone. Check the recipient on the phone card and approve there.',
    noResult: 'The phone approved, but no send result came back. Check that the phone app is up to date.',
  },
} as const
