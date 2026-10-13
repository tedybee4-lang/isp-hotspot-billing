/**
 * Clipboard helper for the provisioning UI.
 *
 * Kept separate from the component so copy behaviour can be tested without a
 * DOM renderer: the only contract that matters is that a clipboard rejection
 * surfaces as a `false` result (the button then tells the operator to copy
 * manually) rather than an unhandled promise rejection.
 */

/** Result of a copy attempt, with a reason the UI can explain. */
export type CopyResult = 'copied' | 'failed'

/**
 * Writes `text` to the system clipboard.
 *
 * Resolves `'copied'` when the browser accepted the write and `'failed'` when
 * the clipboard is unavailable, blocked by permissions, or the page is not
 * served in a secure context. Never throws.
 */
export async function copyText(text: string): Promise<CopyResult> {
  if (!text) return 'failed'
  try {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      return 'failed'
    }
    await clipboard.writeText(text)
    return 'copied'
  } catch {
    return 'failed'
  }
}