// Error text for "Report a problem" shown in the desktop settings (ADR 0029). Korean is the reference copy
export const REPORT_TEXT = {
  ko: {
    failedStatus: (status: number) => `보내지 못했어요 (${status})`,
    failed: (why: string) => `보내지 못했어요: ${why}`,
  },
  en: {
    failedStatus: (status: number) => `Could not send (${status})`,
    failed: (why: string) => `Could not send: ${why}`,
  },
} as const
