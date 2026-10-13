/**
 * Tests for the clipboard helper used by the provisioning page's copy button.
 *
 * A copy that fails must resolve `'failed'` so the button can tell the
 * operator to copy manually — an unhandled rejection would leave the button
 * stuck on "Copy command" with no explanation, and a rejected permission
 * prompt is the normal case on HTTP origins or unprivileged pages.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { copyText } from './clipboard'

const originalClipboard = navigator.clipboard

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: originalClipboard, configurable: true,
  })
  vi.restoreAllMocks()
})

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', {
    value, configurable: true,
  })
}

describe('copyText', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns copied when the clipboard accepts the write', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    await expect(copyText('/tool fetch mode=https url="..."')).resolves.toBe('copied')
    expect(writeText).toHaveBeenCalledWith('/tool fetch mode=https url="..."')
  })

  it('returns failed when the clipboard rejects (permissions or insecure context)', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('NotAllowed')) })
    await expect(copyText('command')).resolves.toBe('failed')
  })

  it('returns failed when the clipboard API is unavailable', async () => {
    setClipboard(undefined)
    await expect(copyText('command')).resolves.toBe('failed')
  })

  it('returns failed for empty text without touching the clipboard', async () => {
    const writeText = vi.fn()
    setClipboard({ writeText })
    await expect(copyText('')).resolves.toBe('failed')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('never throws', async () => {
    setClipboard({ get writeText() { throw new TypeError('weird clipboard') } })
    await expect(copyText('command')).resolves.toBe('failed')
  })
})