import { describe, expect, it } from 'vitest'
import { checkAllowed, destructiveReason, HandsError, normalizeModifiers } from './safety.js'

describe('checkAllowed', () => {
  it('refuses browsers, password managers and Dool2 itself', () => {
    for (const app of ['chrome.exe', 'MSEDGE.EXE', '1password.exe', 'dool2.exe', 'Dool2Helper.exe']) {
      expect(() => checkAllowed(app)).toThrow(HandsError)
    }
  })

  it('allows an ordinary app', () => {
    expect(() => checkAllowed('slack.exe')).not.toThrow()
    expect(() => checkAllowed('notepad.exe')).not.toThrow()
  })

  it('refuses an empty app id', () => {
    expect(() => checkAllowed('')).toThrow(HandsError)
  })
})

describe('normalizeModifiers', () => {
  it('canonicalizes aliases and dedupes', () => {
    expect(normalizeModifiers(['win', 'Control', 'option'])).toEqual(['alt', 'ctrl', 'meta'])
    expect(normalizeModifiers(['cmd', 'command'])).toEqual(['meta'])
  })
  it('throws on an unknown modifier', () => {
    expect(() => normalizeModifiers(['hyper'])).toThrow(HandsError)
  })
})

describe('destructiveReason', () => {
  it('refuses Alt+F4', () => {
    expect(destructiveReason('F4', ['alt'])).toBeTruthy()
  })
  it('refuses any Windows-key shortcut', () => {
    expect(destructiveReason('l', ['win'])).toBeTruthy()
    expect(destructiveReason('d', ['meta'])).toBeTruthy()
  })
  it('refuses Task Manager and the secure-attention sequence', () => {
    expect(destructiveReason('Escape', ['ctrl', 'shift'])).toBeTruthy()
    expect(destructiveReason('Delete', ['ctrl', 'alt'])).toBeTruthy()
  })
  it('allows ordinary keys and combos', () => {
    expect(destructiveReason('Enter', [])).toBeNull()
    expect(destructiveReason('Tab', [])).toBeNull()
    expect(destructiveReason('a', ['ctrl'])).toBeNull()
    expect(destructiveReason('c', ['ctrl'])).toBeNull()
  })
})
