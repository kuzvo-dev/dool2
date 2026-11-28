// English copy for the phone approval card. English must be complete (ADR 0029); Korean (ko.ts) is the reference.

import type { CardCopy } from './types.js'

export const en: CardCopy = {
  title: {
    pay: 'Approve payment',
    contact: 'Approve sending',
    delete: 'Approve deletion',
    act: 'Approve action',
    read: 'Confirm',
  },
  tier: {
    pay: 'Payment',
    contact: 'Send',
    delete: 'Delete',
    act: 'Action',
    read: 'Read',
  },
  field: {
    what: 'What',
    where: 'Where',
    amount: 'Amount',
  },
  approve: 'Approve',
  deny: 'Deny',
  amount: (won: number) => `${won.toLocaleString('en-US')} won`,
}
