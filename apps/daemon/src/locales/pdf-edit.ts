// Names of the PDF files Doori creates (merge / split / extract pages). Korean is the reference copy (ADR 0029)
import type { Lang } from '@dool2/i18n'

export const PDF_EDIT_NAMES = {
  ko: {
    pagesSuffix: (label: string) => `${label}쪽`,
    merged: (stem: string, others: number) => `${stem} 외 ${others}개 합침`,
    extracted: (stem: string, pages: string) => `${stem} ${pages}쪽`,
    copy: (stem: string) => `${stem} 사본`,
  },
  en: {
    pagesSuffix: (label: string) => `p${label}`,
    merged: (stem: string, others: number) => `${stem} + ${others} more merged`,
    extracted: (stem: string, pages: string) => `${stem} p${pages}`,
    copy: (stem: string) => `${stem} copy`,
  },
} as const satisfies Record<Lang, unknown>
