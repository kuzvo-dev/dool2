import { describe, expect, it } from 'vitest'
import { frameView } from './frame.js'

describe('frameView (pane paint mapping)', () => {
  it('paints a data: URL frame and hides the idle placeholder', () => {
    expect(frameView('data:image/jpeg;base64,ABC')).toEqual({
      src: 'data:image/jpeg;base64,ABC',
      showFrame: true,
      showIdle: false,
    })
  })

  it('shows the idle placeholder and no frame when there is nothing to show', () => {
    expect(frameView(null)).toEqual({ src: '', showFrame: false, showIdle: true })
  })
})
