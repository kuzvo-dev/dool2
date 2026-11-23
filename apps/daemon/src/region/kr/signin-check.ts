// Korean text on Korean sites that the sign-in check matches (ADR 0029)

/** A link or button that goes to the account page ("마이페이지", "MY", "마이 페이지ㆍ구매 내역", "마이리디", "HeaderButtonMyPage") */
export const MY_LINK =
  /\[(e\d+) (?:링크|버튼) "((?:마이\s?페이지|마이|MY|My\s?page|MYPAGE|내\s?정보|HeaderButtonMyPage)[^"\]\n]{0,10}|마이\s?\S{1,4})"\]/i

/** What a signed-in person sees on the account page */
export const MY_CONTENT =
  /주문\s?(내역|목록|배송)|배송\s?(조회|현황)|구매\s?내역|예약\s?내역|쿠폰|적립금|포인트|마일리지|회원\s?정보\s?(수정|변경)|내\s?정보\s?(수정|관리)|개인\s?정보\s?(수정|변경)|비밀번호\s?변경|배송지\s?관리|찜한|위시\s?리스트|구독\s?(중|관리)|이용권|my orders|order history/i

/** The password field in a page snapshot */
export const PASSWORD_FIELD = /\[e\d+ 비밀번호칸/
