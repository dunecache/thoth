import { describe, expect, it } from 'vitest';

import { planBootstrap, type LocalEntry } from '../bootstrap-plan.js';

const identityAssetId = (path: string): string => `asset:${path}`;

function plan(
  overrides: Partial<Parameters<typeof planBootstrap>[0]> = {}
): ReturnType<typeof planBootstrap> {
  return planBootstrap({
    haveAuthoritativeSnapshot: true,
    deviceId: 'dev-1',
    serverFiles: {},
    serverAssets: {},
    assetIdForPath: identityAssetId,
    localFiles: [],
    ...overrides,
  });
}

function draftsOf(result: ReturnType<typeof planBootstrap>): unknown[] {
  if (!result.ok) {
    throw new Error(`expected a plan, got ${result.reason}`);
  }
  return result.drafts;
}

describe('planBootstrap', () => {
  it('refuses to upload anything without an authoritative snapshot', () => {
    const result = plan({
      haveAuthoritativeSnapshot: false,
      serverFiles: {},
      localFiles: [
        { kind: 'text', path: 'notes/mine.md', content: 'my own note' },
      ],
    });

    // The regression: a failed snapshot fetch used to be read as "the
    // server is empty", which pushed this device's whole vault over the
    // shared one and destroyed every other device's notes.
    expect(result).toEqual({
      ok: false,
      reason: 'NO_AUTHORITATIVE_SNAPSHOT',
    });
  });

  it('refuses to plan without a registered device', () => {
    expect(plan({ deviceId: '' })).toEqual({ ok: false, reason: 'NO_DEVICE' });
  });

  it('uploads local files the server does not have', () => {
    const drafts = draftsOf(
      plan({
        serverFiles: { 'notes/shared.md': 'from another device' },
        localFiles: [
          { kind: 'text', path: 'notes/shared.md', content: 'from another device' },
          { kind: 'text', path: 'notes/mine.md', content: 'my own note' },
        ],
      })
    );
    expect(drafts).toEqual([
      { type: 'create-note', payload: { path: 'notes/mine.md', content: 'my own note' } },
    ]);
  });

  it('uploads local content that diverges from the server', () => {
    const drafts = draftsOf(
      plan({
        serverFiles: { 'notes/a.md': 'server version' },
        localFiles: [{ kind: 'text', path: 'notes/a.md', content: 'local version' }],
      })
    );
    expect(drafts).toEqual([
      { type: 'replace-content', payload: { path: 'notes/a.md', content: 'local version' } },
    ]);
  });

  it('queues nothing when local and server agree', () => {
    const drafts = draftsOf(
      plan({
        serverFiles: { 'notes/a.md': 'same', 'notes/b.md': 'also same' },
        localFiles: [
          { kind: 'text', path: 'notes/a.md', content: 'same' },
          { kind: 'text', path: 'notes/b.md', content: 'also same' },
        ],
      })
    );
    expect(drafts).toEqual([]);
  });

  it('treats an empty but successful snapshot as an empty server', () => {
    // This is the legitimate first-device case: the fetch worked and the
    // server genuinely holds nothing yet.
    const drafts = draftsOf(
      plan({
        haveAuthoritativeSnapshot: true,
        serverFiles: {},
        localFiles: [{ kind: 'text', path: 'notes/first.md', content: 'hello' }],
      })
    );
    expect(drafts).toEqual([
      { type: 'create-note', payload: { path: 'notes/first.md', content: 'hello' } },
    ]);
  });

  it('skips a binary file the server already stores with the same hash', () => {
    const drafts = draftsOf(
      plan({
        serverAssets: { 'img/a.png': { assetId: 'x', hash: 'abc', size: 10 } },
        localFiles: [
          { kind: 'binary', path: 'img/a.png', hash: 'abc', size: 10 },
        ],
      })
    );
    expect(drafts).toEqual([]);
  });

  it('uploads a binary file the server has under a different hash', () => {
    const drafts = draftsOf(
      plan({
        serverAssets: { 'img/a.png': { assetId: 'x', hash: 'old', size: 10 } },
        localFiles: [
          {
            kind: 'binary',
            path: 'img/a.png',
            hash: 'new',
            size: 12,
            mimeType: 'image/png',
          },
        ],
      })
    );
    expect(drafts).toEqual([
      {
        type: 'add-asset',
        payload: {
          path: 'img/a.png',
          assetId: 'asset:img/a.png',
          hash: 'new',
          size: 12,
          mimeType: 'image/png',
        },
      },
    ]);
  });

  it('uploads a binary file absent from the asset metadata', () => {
    const drafts = draftsOf(
      plan({
        localFiles: [{ kind: 'binary', path: 'img/new.png', hash: 'h', size: 3 }],
      })
    );
    expect(drafts).toHaveLength(1);
    expect((drafts[0] as { type: string }).type).toBe('add-asset');
  });

  it('ignores files that were skipped during reading', () => {
    const drafts = draftsOf(
      plan({
        localFiles: [
          { kind: 'skipped', path: 'img/huge.png', reason: 'too large' },
        ] as LocalEntry[],
      })
    );
    expect(drafts).toEqual([]);
  });
});
