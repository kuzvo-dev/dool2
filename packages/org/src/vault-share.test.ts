import { describe, expect, it } from 'vitest'
import type { Member } from './identity.js'
import { canGroupUse, type SharedVaultItem, type VaultShareRule } from './vault-share.js'

const eng: Member = { memberId: 'm1', email: 'a@corp.com', groups: ['eng', 'leads'], orgId: 'org1' }
const sales: Member = { memberId: 'm2', email: 'b@corp.com', groups: ['sales'], orgId: 'org1' }

const rule: VaultShareRule = { vaultId: 'v1', allowedGroups: ['eng'] }
const item: SharedVaultItem = { itemId: 'i1', vaultId: 'v1' }

describe('canGroupUse', () => {
  it('allows a member in an allowed group', () => {
    expect(canGroupUse(item, rule, eng)).toBe(true)
  })

  it('denies a member in no allowed group', () => {
    expect(canGroupUse(item, rule, sales)).toBe(false)
  })

  it('denies an item from a different vault', () => {
    expect(canGroupUse({ itemId: 'i1', vaultId: 'other' }, rule, eng)).toBe(false)
  })

  it('restricts to listed item ids when the rule names them', () => {
    const narrowed: VaultShareRule = { vaultId: 'v1', allowedGroups: ['eng'], itemIds: ['i2'] }
    expect(canGroupUse({ itemId: 'i1', vaultId: 'v1' }, narrowed, eng)).toBe(false)
    expect(canGroupUse({ itemId: 'i2', vaultId: 'v1' }, narrowed, eng)).toBe(true)
  })

  it('an empty itemIds list means all items are covered', () => {
    const all: VaultShareRule = { vaultId: 'v1', allowedGroups: ['eng'], itemIds: [] }
    expect(canGroupUse(item, all, eng)).toBe(true)
  })
})
