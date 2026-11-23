// Korean data the phone app matches against text that comes from the PC (Korean sites and Korean service cards).

/** Installment options worth showing first: pay in full, interest-free */
export const PREFERRED_INSTALLMENT = /일시불|무이자/

/** A connect card that logs in with an ID, password or email (not social login only) */
export const ID_LOGIN = /아이디|비밀번호|이메일/

/** Tail the PC adds to a "do this yourself" failure message, cut off before the phone adds its own */
export const OPEN_SCREEN_TAIL = /\.?\s*화면을 열어 직접 마쳐 주세요\.?$/
