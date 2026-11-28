import { describe, expect, it } from 'vitest'
import { type Member, mapScimUser, type ScimUser, StaticIdentityProvider } from './identity.js'

describe('mapScimUser', () => {
  it('maps the standard fields and preserves group order', () => {
    const user: ScimUser = {
      id: 'scim-1',
      userName: 'alice',
      emails: [{ value: 'alice@corp.com', primary: true }],
      groups: [{ display: 'eng' }, { display: 'leads' }],
      active: true,
    }
    const member = mapScimUser(user, { orgId: 'org1' })
    expect(member).toEqual<Member>({
      memberId: 'scim-1',
      email: 'alice@corp.com',
      groups: ['eng', 'leads'],
      orgId: 'org1',
    })
  })

  it('falls back to externalId for the member id and to the first email', () => {
    const user: ScimUser = {
      externalId: 'ext-9',
      emails: [{ value: 'first@corp.com' }, { value: 'second@corp.com' }],
    }
    const member = mapScimUser(user, { orgId: 'org1' })
    expect(member.memberId).toBe('ext-9')
    expect(member.email).toBe('first@corp.com')
  })

  it('prefers the primary email over earlier non-primary ones', () => {
    const user: ScimUser = {
      id: 'scim-2',
      emails: [{ value: 'alt@corp.com' }, { value: 'main@corp.com', primary: true }],
    }
    expect(mapScimUser(user, { orgId: 'org1' }).email).toBe('main@corp.com')
  })

  it('takes group value when display is absent and drops groups with neither', () => {
    const user: ScimUser = {
      id: 'scim-3',
      emails: [{ value: 'a@corp.com' }],
      groups: [{ value: 'g-123' }, {}, { display: 'named' }],
    }
    expect(mapScimUser(user, { orgId: 'org1' }).groups).toEqual(['g-123', 'named'])
  })

  it('throws when the stable id is missing', () => {
    const user: ScimUser = { emails: [{ value: 'a@corp.com' }] }
    expect(() => mapScimUser(user, { orgId: 'org1' })).toThrow(/stable id/)
  })

  it('throws when the email is missing', () => {
    expect(() => mapScimUser({ id: 'x' }, { orgId: 'org1' })).toThrow(/email/)
    expect(() => mapScimUser({ id: 'x', emails: [] }, { orgId: 'org1' })).toThrow(/email/)
  })
})

describe('StaticIdentityProvider', () => {
  const alice: Member = { memberId: 'm1', email: 'a@corp.com', groups: ['eng'], orgId: 'org1' }

  it('resolves a seeded subject and returns undefined for an unknown one', async () => {
    const provider = new StaticIdentityProvider([['sub-alice', alice]])
    expect(provider.name).toBe('static')
    expect(await provider.resolve('sub-alice')).toEqual(alice)
    expect(await provider.resolve('sub-nobody')).toBeUndefined()
  })
})
