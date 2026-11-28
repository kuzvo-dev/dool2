// Korean equivalent-domain groups: hosts that share one account even though they are different registrable domains,
// so a login saved for one is offered on the others (ADR 0029 keeps this Korean data under region/kr). A naver
// login is entered on nid.naver.com; a kakao login is also used on daum. These are data, not rules.

/**
 * Each inner array is a group of hosts that count as the same site for the vault. Subdomains match their parent
 * automatically (nid.naver.com matches naver.com), so a group is only needed where the registrable domains differ.
 */
export const KR_EQUIVALENT_DOMAINS: readonly (readonly string[])[] = [
  // Naver: login lives on nid.naver.com (listed for clarity; subdomain matching already links it to naver.com).
  ['naver.com', 'nid.naver.com'],
  // Kakao / Daum share one account.
  ['kakao.com', 'daum.net', 'accounts.kakao.com'],
]
