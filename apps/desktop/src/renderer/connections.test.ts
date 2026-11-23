import { CONNECT_CATEGORIES, type ConnectCard, SOCIAL_LABEL as SOCIAL } from '@dool2/protocol/connect'
import { describe, expect, it } from 'vitest'
import { CATEGORY_LABEL, SOCIAL_LABEL, safetyLines } from './connections.js'

describe('서비스 연결 화면', () => {
  it('분류 이름이 프로토콜과 같다 (화면 번들용 복사본)', () => {
    expect(CATEGORY_LABEL).toEqual(CONNECT_CATEGORIES)
    expect(SOCIAL_LABEL).toEqual(SOCIAL)
  })

  it('안전 안내는 연결 방식과 등급에서 만든다', () => {
    const card = {
      id: 'demo',
      name: '데모',
      site: 'demo.co.kr',
      category: 'shopping',
      how: 'browser',
      login: '카카오 간편 로그인',
      summary: '데모를 연결하면 주문까지 맡길 수 있어요.',
      example: { ask: '시켜 줘', working: '찾는 중', reply: '주문할까요?' },
      abilities: [
        { title: '찾기', say: '찾아 줘', tier: 'lookup' },
        { title: '주문', say: '시켜 줘', tier: 'pay' },
      ],
    } satisfies ConnectCard
    const lines = safetyLines(card)
    expect(lines[0]).toContain('카카오 간편 로그인')
    expect(lines.at(-1)).toContain('폰에서 승인')
    const open = safetyLines({ ...card, how: 'open', abilities: [card.abilities[0]] })
    expect(open).toEqual(['로그인 없이 쓰는 서비스예요. 연결하지 않아도 바로 부탁하면 돼요.'])
  })
})
