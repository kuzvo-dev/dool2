// Errors the browser bridge returns. Browser tools pass them to the AI and to connect cards.
// The daemon matches `notConnected` (apps/daemon/src/connectors.ts), so the Korean text is what goes out for now;
// switch to the user's language once that check matches an error code instead of the words.
const ko = {
  notConnected: 'Chrome의 두리 확장 프로그램과 연결돼 있지 않아요',
  timeout: '브라우저가 제때 답하지 않았어요',
  closed: '브라우저 연결이 끊겼어요',
}

const en: typeof ko = {
  notConnected: 'Not connected to the Dool2 extension in Chrome',
  timeout: "The browser didn't answer in time",
  closed: 'The browser connection was closed',
}

export const BRIDGE_TEXT = { ko, en }
