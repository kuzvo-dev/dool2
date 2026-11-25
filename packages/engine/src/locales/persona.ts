// Markers in Dool2's instructions. The voices per language moved to prompts/voice/<lang>.md (ADR 0040).

/**
 * Markers other parts of the app write or parse in Korean, so the instructions must quote them exactly.
 * `quickReply` is the `[[답: a | b]]` line that `splitQuick` in `@dool2/protocol/rich` turns into buttons, and
 * `photo` is the `[사진: name.jpg]` note the apps add when the user sends a photo, and `myAddress` is the value
 * the daemon replaces with the profile address in a service tool's address field.
 */
export const PERSONA_MARKERS = {
  quickReply: '답',
  photo: '사진',
  myAddress: '내 주소',
} as const
