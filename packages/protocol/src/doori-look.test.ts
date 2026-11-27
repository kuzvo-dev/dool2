import { describe, expect, it } from 'vitest'
import { DooriLookSchema, drawDoori, randomLook } from './doori-look.js'

describe('Doori drawing and look', () => {
  it('draws the default Doori: the keyhole mouth and the 2 dot, no legs', () => {
    const svg = drawDoori()
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('#4cc98f')
    // keyhole: a circle and a trapezoid under it
    expect(svg).toMatch(/<circle cx="60" cy="[\d.]+" r="4"/)
    // the "2" dot sits at the top right when there is no hat
    expect(svg).toMatch(/r="7" fill="#16241d"/)
  })

  it('wears what the look says and every mood draws', () => {
    const svg = drawDoori({
      color: 'sky',
      hat: 'crown',
      face: 'round',
      neck: 'tie',
      cheeks: true,
      pattern: 'spots',
    })
    expect(svg).toContain('#58a8f0')
    expect(svg).toContain('#f2c94c') // crown
    expect(svg).toContain('#2f5fd0') // tie
    for (const mood of ['idle', 'thinking', 'working', 'asking', 'done', 'sleeping'] as const)
      expect(drawDoori({ mood })).toContain('</svg>')
  })

  it('accepts only known parts, and random looks are always valid', () => {
    expect(DooriLookSchema.safeParse({ color: 'mint', hat: '' }).success).toBe(true)
    expect(DooriLookSchema.safeParse({ color: 'gold' }).success).toBe(false)
    expect(DooriLookSchema.safeParse({ hat: '<script>' }).success).toBe(false)
    for (let i = 0; i < 50; i++) expect(DooriLookSchema.safeParse(randomLook()).success).toBe(true)
  })
})
