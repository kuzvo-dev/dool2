// Header that segments saved before ADR 0029 start their carried-over text with. Still stripped when that text is
// carried into the next segment.
export const OLD_CARRY_HEAD = /^\[앞 대화에서 이어져요\][^\n]*\n?/
