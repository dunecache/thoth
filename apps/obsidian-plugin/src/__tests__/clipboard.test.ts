import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyToClipboard } from '../clipboard.js';

/**
 * Clipboard support is not guaranteed on every Obsidian platform, so the
 * helper reports failure rather than throwing. Every caller shows the value as
 * well, which makes a failed copy a downgrade rather than a dead end.
 */

const originalNavigator = globalThis.navigator;

function withNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  withNavigator(originalNavigator);
  vi.restoreAllMocks();
});

describe('copyToClipboard', () => {
  it('copies when the clipboard is available', async () => {
    const writeText = vi.fn(async () => {});
    withNavigator({ clipboard: { writeText } });

    expect(await copyToClipboard('thoth://?serverUrl=x&vaultId=y')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('thoth://?serverUrl=x&vaultId=y');
  });

  it('reports failure instead of throwing when the clipboard rejects', async () => {
    withNavigator({
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('not allowed');
        }),
      },
    });

    expect(await copyToClipboard('x')).toBe(false);
  });

  it('reports failure when there is no clipboard at all', async () => {
    withNavigator({});

    expect(await copyToClipboard('x')).toBe(false);
  });

  it('reports failure when the clipboard has no writeText', async () => {
    withNavigator({ clipboard: {} });

    expect(await copyToClipboard('x')).toBe(false);
  });

  it('reports failure when navigator is missing entirely', async () => {
    withNavigator(undefined);

    expect(await copyToClipboard('x')).toBe(false);
  });
});
