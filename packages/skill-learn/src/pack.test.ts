import { generateKeyPairSync } from 'node:crypto'
import { unpackToFiles, verifyPack } from '@dool2/packs'
import { describe, expect, it } from 'vitest'
import { draftSkill } from './draft.js'
import { installablePack, toPackFiles } from './pack.js'
import type { SessionRecording } from './recording.js'

const recording: SessionRecording = {
  url: 'https://order.coupang.com/list',
  host: 'order.coupang.com',
  apiCalls: [{ method: 'GET', url: 'https://order.coupang.com/api/v1/orders' }],
  keywordsSeen: ['쿠팡'],
}

describe('installablePack', () => {
  it('builds a signed pack of drafted skills that verifies', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

    const drafted = draftSkill(recording)
    const pack = installablePack([drafted], privPem, { pack: 42 })

    const result = verifyPack(pack, pubPem)
    expect(result.ok).toBe(true)
    expect(pack.manifest.name).toBe('skills')
    expect(pack.manifest.files.map((f) => f.path)).toContain(`${drafted.id}/SKILL.md`)

    const files = unpackToFiles(pack)
    const text = new TextDecoder().decode(files[`${drafted.id}/SKILL.md`])
    expect(text).toBe(drafted.markdown)
  })

  it('maps drafted skills to <id>/SKILL.md files', () => {
    const drafted = draftSkill(recording)
    const files = toPackFiles([drafted])
    expect(Object.keys(files)).toEqual([`${drafted.id}/SKILL.md`])
  })
})
