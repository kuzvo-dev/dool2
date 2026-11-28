// The seeded demo card (offline mode), so the phone app renders a full approval screen with no live daemon — which is
// also what the smoke screenshot captures. It is a REAL, signable ApprovalNeeded (a valid envelope + its hash), so the
// device key signs it for real in the demo; there is just no daemon to post the signature to.
//
// The data is GENERIC on purpose (repo rule: no other companies' product names in app screens). It reads as a train
// booking without naming a rail operator or a card brand, and every would-be secret is masked ("····4821").
// This is a `locales/` file, so the Korean display copy lives here.

import type { Lang } from '@dool2/i18n'
import type { PendingCard } from '../../lib/card.js'
import { hashEnvelopeHex } from '../../lib/webcrypto.js'

const COPY: Record<Lang, { service: string; label: string; rows: { key: string; value: string }[] }> = {
  ko: {
    service: '기차 예매',
    label: '기차표 결제',
    rows: [
      { key: '열차', value: '특급 101 · 11/16(월) 09:00' },
      { key: '구간', value: '서울 → 부산 · 2시간 38분' },
      { key: '좌석', value: '7호차 12A · 창가' },
      { key: '결제', value: '저장된 카드 ····4821' },
    ],
  },
  en: {
    service: 'Train booking',
    label: 'Train ticket',
    rows: [
      { key: 'Train', value: 'Express 101 · Mon 11/16 09:00' },
      { key: 'Route', value: 'Seoul → Busan · 2h 38m' },
      { key: 'Seat', value: 'Car 7, 12A · window' },
      { key: 'Card', value: 'Saved card ····4821' },
    ],
  },
}

/** A seeded, signable pay card for offline/demo mode. `source` is just the service; the app appends the "pays from
 *  your Mac" tail from the locale. The envelope's hash is computed the real way (WebCrypto), so signing it produces a
 *  real signature. */
export async function demoCard(lang: Lang): Promise<PendingCard> {
  const copy = COPY[lang]
  const envelope = {
    tier: 'pay' as const,
    label: copy.label,
    amountKrw: 59_800,
    nonce: 'demo-0000-0000-0000',
    createdAt: 0,
  }
  return {
    hash: await hashEnvelopeHex(envelope),
    envelope,
    source: copy.service,
    rows: copy.rows,
  }
}
