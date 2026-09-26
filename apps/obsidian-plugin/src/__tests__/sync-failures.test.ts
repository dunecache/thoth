import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Operation } from '@thoth/protocol';

import {
  downloadAsset,
  downloadOperations,
  downloadSnapshot,
  uploadAsset,
  uploadOperations,
} from '../sync-engine.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(response: Response | (() => Response)): void {
  globalThis.fetch = vi.fn(async () =>
    typeof response === 'function' ? response() : response
  ) as unknown as typeof fetch;
}

const base = {
  serverUrl: 'https://sync.test',
  vaultId: 'vault-1',
  apiKey: 'key-1',
};

const note: Operation = {
  id: 'op-1',
  type: 'create-note',
  deviceId: 'dev-1',
  revision: 0,
  payload: { path: 'a.md', content: 'a' },
};

describe('failure classification', () => {
  it('flags a 401 as unauthorized and prefers the server message', async () => {
    stubFetch(
      jsonResponse(401, {
        error: 'DEVICE_NOT_REGISTERED',
        message: 'this device is no longer registered on the vault',
      })
    );

    const result = await uploadOperations({
      ...base,
      baseRevision: 0,
      operations: [note],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unauthorized).toBe(true);
    expect(result.error).toBe(
      'this device is no longer registered on the vault'
    );
  });

  it('still flags unauthorized when the body is not JSON', async () => {
    stubFetch(new Response('nope', { status: 401 }));

    const result = await downloadOperations({ ...base, sinceRevision: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unauthorized).toBe(true);
    expect(result.error).toContain('Pull failed with status 401');
  });

  it('flags a 410 as needing a snapshot, not a re-register', async () => {
    stubFetch(
      jsonResponse(410, {
        error: 'HISTORY_TRUNCATED',
        message: 'requested revision is older than the retained history',
      })
    );

    const result = await downloadOperations({ ...base, sinceRevision: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.needsSnapshot).toBe(true);
    expect(result.unauthorized).toBeUndefined();
  });

  it('leaves a conflict classified as an ordinary failure', async () => {
    stubFetch(
      jsonResponse(409, {
        error: 'REVISION_MISMATCH',
        message: 'server is at revision 12',
      })
    );

    const result = await uploadOperations({
      ...base,
      baseRevision: 0,
      operations: [note],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unauthorized).toBeUndefined();
    expect(result.needsSnapshot).toBeUndefined();
    expect(result.error).toContain('Conflict');
  });

  it('does not mark a 500 as unauthorized', async () => {
    stubFetch(
      jsonResponse(500, {
        error: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      })
    );

    const result = await downloadSnapshot(base);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unauthorized).toBeUndefined();
    expect(result.error).toBe('An unexpected error occurred');
  });

  it('classifies asset upload failures too', async () => {
    stubFetch(
      jsonResponse(401, {
        error: 'DEVICE_NOT_REGISTERED',
        message: 'revoked',
      })
    );

    const result = await uploadAsset({
      ...base,
      assetId: 'a.png',
      data: new ArrayBuffer(4),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unauthorized).toBe(true);
  });

  it('classifies asset download failures too', async () => {
    stubFetch(jsonResponse(403, { error: 'FORBIDDEN', message: 'nope' }));

    const result = await downloadAsset({ ...base, assetId: 'a.png' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 403 is a plain failure: this client is not expected to see one, and
    // it must not be mistaken for a re-registerable credential.
    expect(result.unauthorized).toBeUndefined();
    expect(result.error).toBe('nope');
  });

  it('reports the server message on every request path', async () => {
    stubFetch(
      jsonResponse(401, {
        error: 'DEVICE_NOT_REGISTERED',
        message: 'revoked device',
      })
    );

    const paths = [
      await downloadOperations({ ...base, sinceRevision: 0 }),
      await downloadSnapshot(base),
      await downloadAsset({ ...base, assetId: 'a' }),
      await uploadAsset({ ...base, assetId: 'a', data: new ArrayBuffer(2) }),
      await uploadOperations({ ...base, baseRevision: 0, operations: [note] }),
    ];

    for (const result of paths) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.unauthorized, 'every path must surface revocation').toBe(true);
      expect(result.error).toBe('revoked device');
    }
  });

  it('keeps successful responses untouched', async () => {
    stubFetch(jsonResponse(200, { revision: 7, operations: [] }));
    const result = await downloadOperations({ ...base, sinceRevision: 0 });
    expect(result).toEqual({ ok: true, revision: 7, operations: [] });
  });
});
