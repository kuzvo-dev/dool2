// Text people read while Dool2 connects a service by logging in: steps on the connect card, results, and
// questions on the phone. Korean is the reference, English must have the same keys (ADR 0029).
import { messages } from '@dool2/i18n'

/** Social login provider names as shown to people */
export const PROVIDER_NAMES = {
  ko: {
    kakao: '카카오',
    naver: '네이버',
    google: '구글',
    apple: 'Apple',
    facebook: '페이스북',
    payco: '페이코',
    toss: '토스',
  },
  en: {
    kakao: 'Kakao',
    naver: 'Naver',
    google: 'Google',
    apple: 'Apple',
    facebook: 'Facebook',
    payco: 'PAYCO',
    toss: 'Toss',
  },
} as const

export const autoLoginText = messages({
  ko: {
    // Steps on the connect card
    opening: (name: string) => `${name} 여는 중`,
    findingLogin: '로그인 화면 찾는 중',
    pressing: (label: string) => `"${label}" 누르는 중`,
    enteringId: '아이디 넣는 중',
    enteringPasswordAndLogin: '비밀번호 넣고 로그인 누르는 중',
    checkingLogin: '로그인됐는지 확인하는 중',
    enteringCreds: '아이디·비밀번호 넣는 중',
    pressingLogin: '로그인 누르는 중',
    confirmed: '확인됐어요, 이어서 하는 중',
    waking: (name: string) => `오래 쉬던 ${name} 계정 깨우는 중`,
    waitingCode: '인증번호를 기다리는 중',
    findingProviderButton: (label: string) => `${label} 로그인 버튼 찾는 중`,
    pressingProvider: (label: string) => `${label} 로그인 누르는 중`,
    joining: (name: string, label: string) => `${name}에 ${label} 계정으로 가입하는 중`,
    enteringProviderAccount: (label: string) => `${label} 계정 넣는 중`,
    waitingAccountPick: (label: string) => `${label} 계정 고르기를 기다리는 중`,
    waitingAccountCheck: (label: string) => `${label} 계정 확인을 기다리는 중`,
    pickingRequired: '필수 정보 제공 동의 고르는 중',
    pickingAccount: '계정 고르는 중',
    passingConsent: '정보 제공 동의 넘기는 중',
    // Approving in a phone app
    confirmIn: (where: string) => `${where}에서 확인을 눌러 주세요`,
    viewScreen: '화면 보기',
    confirmDetail: (where: string) => `${where}에 온 로그인 확인을 눌러 주시면 두리가 이어서 해요`,
    confirmWaiting: (where: string) =>
      `${where}에서 확인을 아직 기다리고 있어요. 확인을 누르시면 두리가 이어서 연결해요`,
    whereKakaoTalk: '카카오톡',
    whereNaverApp: '네이버 앱',
    whereToss: '토스 앱',
    wherePhone: '휴대전화',
    wherePhoneApp: '휴대폰 앱',
    // Results
    providerPageStop: (other: string) =>
      `${other} 간편 로그인 화면으로 넘어가서 멈췄어요. ${other}로 연결하거나 화면을 보며 직접 해 주세요.`,
    noLoginFields: '로그인 칸을 찾지 못했어요. 화면을 보면서 직접 로그인해 주세요.',
    dormantHuman: (name: string, why: string) =>
      `${name} 계정이 오래 쓰지 않아 쉬고 있어요. 다시 쓰려면 ${why}이 필요해요`,
    wrong: '아이디나 비밀번호가 맞지 않는 것 같아요. 다시 확인해 주세요.',
    unknown: '로그인됐는지 확인하지 못했어요. 화면을 보고 확인해 주세요.',
    captcha: '로봇 확인(보안 문자)이 떴어요',
    identity: '본인인증이 필요해요',
    checkNeeded: '직접 확인이 필요해요',
    certScreen: (app: string) =>
      `본인인증 창이에요. 이름·휴대폰 번호·생년월일을 넣고 [인증하기]를 누른 뒤, ${app} 앱 알림에서 승인해 주시면 두리가 이어서 할게요`,
    certToss: '토스',
    certPass: 'PASS(통신사)',
    certOther: '인증',
    noProviderButton: (label: string) =>
      `로그인 화면에서 ${label} 버튼을 찾지 못했어요. 화면을 보면서 직접 로그인해 주세요.`,
    joinNeedsCert: (name: string, what: string) =>
      `${name} 가입에 ${what}이 필요해요. 화면에서 인증해 주시면 두리가 이어서 해요`,
    loginNeedsCert: (name: string) =>
      `${name}가 로그인할 때 본인인증(이름·생년월일·휴대폰)을 요구해요. 화면에서 인증해 주시면 두리가 이어서 해요`,
    notMember: (name: string, label: string, cert?: string) =>
      `${name}에 이 ${label} 계정과 연결된 회원이 없어요.${cert ? ` 가입에 ${cert}이 필요해요.` : ''} 이미 쓰는 계정이 있으면 그 방법으로 연결해 주세요`,
    backToLogin: (name: string, label: string) =>
      `${name}에 이 ${label} 계정과 연결된 회원이 없는 것 같아요(로그인 화면으로 돌아왔어요). 이미 쓰는 계정이 있으면 그 방법으로 연결해 주세요`,
    existing: (name: string, label: string, account?: string) =>
      `${name}에 이미 계정${account ? `(${account})` : ''}이 있어요. 그 계정 비밀번호로 한 번 로그인하면 ${label}와 연결돼요`,
    notMemberJoin: (name: string, label: string) =>
      `${name}에 이 ${label} 계정과 연결된 회원이 없어요. 이미 쓰는 계정이 있으면 그 방법으로 연결해 주시고, 처음이면 가입할게요`,
    notMemberJoinCert: (name: string, label: string, why: string) =>
      `${name}에 이 ${label} 계정과 연결된 회원이 없어요. 가입에 ${why}이 필요해요`,
    joinUnfinished: (name: string) => `${name} 가입을 마치지 못했어요. 화면을 보면서 마저 해 주세요`,
    providerLoginNeeded: (label: string) =>
      `${label} 로그인이 필요해요. 한 번 로그인해 두면 다음부터는 두리가 버튼만 눌러요`,
    providerWrong: (label: string) =>
      `${label} 아이디나 비밀번호가 맞지 않는 것 같아요. 화면을 보고 확인해 주세요.`,
    pickAccount: (label: string) => `${label} 계정이 여러 개라 어느 것으로 할지 골라 주셔야 해요`,
    changeAccount: (label: string) =>
      `${label} 계정을 바꾸는 화면이에요. 쓰시는 ${label} 계정으로 로그인해 주시면 두리가 이어서 해요`,
    checkAccount: (label: string, who: string) => `${label}에 로그인된 계정(${who})이 맞는지 확인이 필요해요`,
    requiredStuck: (label: string) =>
      `${label} 동의 화면의 (필수) 칸이 눌러지지 않아요. 화면에서 (필수) 칸을 고르고 [동의하고 계속하기]를 눌러 주세요`,
    providerUnknown: (label: string) =>
      `${label} 로그인을 마쳤는지 확인하지 못했어요. 화면을 보고 확인해 주세요.`,
    // Questions on the phone
    codeLabel: '인증번호',
    telLabel: '휴대폰 번호',
    providerAccount: (label: string) => `${label} 계정`,
    whichAccount: (label: string) => `어느 ${label} 계정으로 할까요?`,
    whichAccountHint: (name: string) =>
      `${name}에 이 계정으로 로그인해요. 고른 계정은 기억해 두고 다음부터 묻지 않아요.`,
    useAccount: (who: string) => `${who}(으)로 할게요`,
    confirmAccount: (label: string, who: string, name: string) =>
      `${label} 계정 ${who}(으)로 ${name}에 로그인할까요?`,
    confirmAccountHint: (label: string) =>
      `이 PC에 로그인된 ${label} 계정이에요. 처음 보는 계정이라 여쭤봐요. 맞으면 기억해 두고 다음부터 묻지 않아요.`,
    otherAccount: '다른 계정이에요',
    // Login check (probe)
    twoStep: (name: string) => `${name} (두 단계)`,
  },
  en: {
    opening: (name) => `Opening ${name}`,
    findingLogin: 'Finding the login page',
    pressing: (label) => `Pressing "${label}"`,
    enteringId: 'Entering the ID',
    enteringPasswordAndLogin: 'Entering the password and logging in',
    checkingLogin: 'Checking the login',
    enteringCreds: 'Entering the ID and password',
    pressingLogin: 'Pressing login',
    confirmed: 'Confirmed, continuing',
    waking: (name) => `Waking up the unused ${name} account`,
    waitingCode: 'Waiting for the verification code',
    findingProviderButton: (label) => `Finding the ${label} login button`,
    pressingProvider: (label) => `Pressing ${label} login`,
    joining: (name, label) => `Joining ${name} with the ${label} account`,
    enteringProviderAccount: (label) => `Entering the ${label} account`,
    waitingAccountPick: (label) => `Waiting for you to pick a ${label} account`,
    waitingAccountCheck: (label) => `Waiting for you to confirm the ${label} account`,
    pickingRequired: 'Checking the required consent boxes',
    pickingAccount: 'Picking the account',
    passingConsent: 'Accepting the info sharing consent',
    confirmIn: (where) => `Approve in ${where}`,
    viewScreen: 'View screen',
    confirmDetail: (where) => `Approve the login request in ${where} and Dool2 will continue`,
    confirmWaiting: (where) =>
      `Still waiting for approval in ${where}. Approve it and Dool2 will finish connecting`,
    whereKakaoTalk: 'KakaoTalk',
    whereNaverApp: 'the Naver app',
    whereToss: 'the Toss app',
    wherePhone: 'your phone',
    wherePhoneApp: 'the app on your phone',
    providerPageStop: (other) =>
      `Stopped on the ${other} login page. Connect with ${other} instead, or finish on the screen yourself.`,
    noLoginFields: "Couldn't find the login fields. Please log in on the screen yourself.",
    dormantHuman: (name, _why) =>
      `Your ${name} account is dormant from long disuse. Identity verification is needed to use it again`,
    wrong: "The ID or password doesn't seem right. Please check them again.",
    unknown: "Couldn't confirm the login. Please check the screen.",
    captcha: 'A CAPTCHA appeared',
    identity: 'Identity verification is needed',
    checkNeeded: 'Needs your check',
    certScreen: (app) =>
      `This is an identity check. Enter your name, phone number and date of birth, press the verify button, then approve the ${app} app notification and Dool2 will continue`,
    certToss: 'Toss',
    certPass: 'PASS (carrier)',
    certOther: 'verification',
    noProviderButton: (label) =>
      `Couldn't find the ${label} button on the login page. Please log in on the screen yourself.`,
    joinNeedsCert: (name, _what) =>
      `Joining ${name} needs identity verification. Verify on the screen and Dool2 will continue`,
    loginNeedsCert: (name) =>
      `${name} asks for identity verification (name, date of birth, phone) to log in. Verify on the screen and Dool2 will continue`,
    notMember: (name, label, cert) =>
      `No ${name} member is linked to this ${label} account.${cert ? ' Joining needs identity verification.' : ''} If you already have an account, connect with that method`,
    backToLogin: (name, label) =>
      `No ${name} member seems linked to this ${label} account (it went back to the login page). If you already have an account, connect with that method`,
    existing: (name, label, account) =>
      `You already have a ${name} account${account ? ` (${account})` : ''}. Log in once with its password to link it to ${label}`,
    notMemberJoin: (name, label) =>
      `No ${name} member is linked to this ${label} account. If you already have an account, connect with that method. If you're new, Dool2 will sign you up`,
    notMemberJoinCert: (name, label, _why) =>
      `No ${name} member is linked to this ${label} account. Joining needs identity verification`,
    joinUnfinished: (name) => `Couldn't finish joining ${name}. Please finish on the screen`,
    providerLoginNeeded: (label) =>
      `Logging in to ${label} is needed. Log in once and next time Dool2 just presses the button`,
    providerWrong: (label) => `The ${label} ID or password doesn't seem right. Please check the screen.`,
    pickAccount: (label) => `You have several ${label} accounts. Please pick one`,
    changeAccount: (label) =>
      `This is the ${label} account switch page. Log in with your ${label} account and Dool2 will continue`,
    checkAccount: (label, who) => `Please confirm the account logged in to ${label} (${who}) is yours`,
    requiredStuck: (label) =>
      `The required boxes on the ${label} consent page don't respond. Check them on the screen and press the agree and continue button`,
    providerUnknown: (label) => `Couldn't confirm the ${label} login finished. Please check the screen.`,
    codeLabel: 'Verification code',
    telLabel: 'Phone number',
    providerAccount: (label) => `${label} account`,
    whichAccount: (label) => `Which ${label} account should I use?`,
    whichAccountHint: (name) =>
      `Logs in to ${name} with this account. Dool2 remembers your choice and won't ask again.`,
    useAccount: (who) => `Use ${who}`,
    confirmAccount: (label, who, name) => `Log in to ${name} with the ${label} account ${who}?`,
    confirmAccountHint: (label) =>
      `This ${label} account is logged in on this PC. Dool2 hasn't seen it before, so it's asking. If it's yours, Dool2 remembers it and won't ask again.`,
    otherAccount: "It's a different account",
    twoStep: (name) => `${name} (two steps)`,
  },
})
