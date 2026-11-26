import { describe, expect, it } from 'vitest'
import { pricedModels, priceKey, readPrices } from './payg-models.js'

const book = readPrices({
  data: [
    {
      id: '~z-ai/glm-latest',
      name: 'Z.ai: GLM Latest',
      pricing: { prompt: '0.00000007', completion: '0.0000014' },
      supported_parameters: ['tools'],
    },
    {
      id: 'anthropic/claude-sonnet-5.5',
      name: 'Anthropic: Claude Sonnet 5.5',
      pricing: { prompt: '0.000002', completion: '0.00001' },
      supported_parameters: ['tools'],
    },
    {
      id: 'anthropic/claude-haiku-5.5',
      name: 'Anthropic: Claude Haiku 5.5',
      pricing: { prompt: '0.0000001', completion: '0.0000005' },
      supported_parameters: ['tools'],
    },
    {
      id: 'some/no-tools',
      name: 'X: No Tools',
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: [],
    },
    {
      id: 'deepseek/flash:batch',
      name: 'DeepSeek: Flash (batch)',
      pricing: { prompt: '0.00000001', completion: '0.00000002' },
      supported_parameters: ['tools'],
    },
  ],
})

describe('API key form model list', () => {
  it('lists what the runner can use, priced, the pick first and then cheapest first', () => {
    const provider = { id: 'openrouter', label: 'OpenRouter', keyUrl: '', models: [] }
    const list = pricedModels(
      provider,
      ['anthropic/claude-sonnet-5.5', '~z-ai/glm-latest', 'some/no-tools', 'deepseek/flash:batch'],
      book,
    )
    expect(list.map((m) => m.id)).toEqual(['~z-ai/glm-latest', 'anthropic/claude-sonnet-5.5'])
    expect(list[0]).toMatchObject({ label: 'GLM Latest', recommended: true, inPerM: 0.07 })
    expect(list[0]?.outPerM).toBeCloseTo(1.4)
  })

  it("prices a company's own model under its OpenRouter name, and keeps the fixed list without prices", () => {
    expect(priceKey('anthropic', 'claude-haiku-5-5')).toBe('anthropic/claude-haiku-5.5')
    const anthropic = {
      id: 'anthropic',
      label: 'Anthropic',
      keyUrl: '',
      models: [
        { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
        { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 · 추천' },
      ],
    }
    const list = pricedModels(anthropic, undefined, book)
    expect(list.map((m) => m.id)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5'])
    expect(list[0]?.inPerM).toBeCloseTo(0.1)
    expect(pricedModels(anthropic, undefined, new Map()).map((m) => m.id)).toEqual([
      'claude-haiku-5-5',
      'claude-sonnet-5-5',
    ])
  })
})
