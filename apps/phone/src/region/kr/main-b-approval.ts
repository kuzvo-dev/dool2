// Korean words the phone matches in approval cards (labels sent by the daemon from Korean sites).

/** Info row that holds the arrival or usage time (shown in the card header) */
export const WHEN_LABEL_RE = /도착|이용|일시|체크인|출발/
export const REQUEST_LABEL_RE = /요청/
export const TIME_LABEL_RE = /도착|일시|시간|체크/
export const PEOPLE_LABEL_RE = /예약자|탑승객|투숙객|받는|휴대폰|전화|연락처/
export const TICKET_LABEL_RE = /좌석|티켓/
/** Prefix the daemon puts on the delivery option that comes from "my info" */
export const MY_ADDRESS_PREFIX = '내 정보 주소 · '
export const MY_ADDRESS_PREFIX_RE = /^내 정보 주소 · /
/** Honorific after a contact name ("김 팀장님"), dropped before searching contacts */
export const HONORIFIC_RE = /님$/
