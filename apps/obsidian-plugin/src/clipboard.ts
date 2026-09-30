/**
 * Clipboard access that degrades instead of failing.
 *
 * `navigator.clipboard` requires a secure context and a focused document, so
 * it is not reliably present on every Obsidian platform — notably some mobile
 * WebViews. The clipboard is only a convenience here: every caller also shows
 * the value, so a failure is a downgrade rather than a dead end.
 */

/** Copies text, reporting whether the clipboard accepted it. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard?.writeText) {
    return false;
  }
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    // Permission denied, or the document was not focused. The caller falls
    // back to letting the user select the text.
    return false;
  }
}
