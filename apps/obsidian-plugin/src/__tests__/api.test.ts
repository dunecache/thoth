import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildInviteLink,
  checkHealth,
  parseImportVaultLink,
  testAuthentication,
} from '../api.js';

function stubFetchOnce(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkHealth', () => {
  it('returns ok for a healthy server and normalizes trailing slashes', async () => {
    stubFetchOnce(200, { status: 'ok' });
    const result = await checkHealth('https://sync.example.com/');

    expect(result).toEqual({ ok: true, message: 'Server is reachable' });
    expect(fetch).toHaveBeenCalledWith('https://sync.example.com/health');
  });

  it('returns a failure for a non-200 response', async () => {
    stubFetchOnce(500, { error: 'INTERNAL_ERROR' });
    const result = await checkHealth('https://sync.example.com');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('status 500');
    }
  });

  it('returns a failure for an unexpected payload', async () => {
    stubFetchOnce(200, { status: 'degraded' });
    const result = await checkHealth('https://sync.example.com');

    expect(result.ok).toBe(false);
  });

  it('returns a failure when the request throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('fetch failed'))
    );
    const result = await checkHealth('https://sync.example.com');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Health check failed');
    }
  });
});

describe('testAuthentication', () => {
  const params = {
    serverUrl: 'https://sync.example.com',
    vaultId: 'vault-1',
    deviceId: 'dev-1',
    apiKey: 'secret',
  };

  it('returns ok when the server confirms the API key', async () => {
    stubFetchOnce(200, { valid: true });
    const result = await testAuthentication(params);

    expect(result).toEqual({ ok: true, message: 'Authentication succeeded' });
    expect(fetch).toHaveBeenCalledWith(
      'https://sync.example.com/vaults/vault-1/devices/dev-1/validate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret',
        },
        body: JSON.stringify({ apiKey: 'secret' }),
      }
    );
  });

  it('returns a failure when the API key is invalid', async () => {
    stubFetchOnce(200, { valid: false });
    const result = await testAuthentication(params);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('invalid API key');
    }
  });

  it('returns a failure for a non-200 response', async () => {
    stubFetchOnce(404, { error: 'NOT_FOUND' });
    const result = await testAuthentication(params);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('status 404');
    }
  });

  it('returns a failure when the request throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('fetch failed'))
    );
    const result = await testAuthentication(params);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Authentication failed');
    }
  });
});

describe('invite links', () => {
  it('round-trips through the parser', () => {
    // The export and the import are written independently, so a change to
    // either format that the other does not follow would lock a second device
    // out of the vault with no way to recover.
    const link = buildInviteLink('https://sync.example.com', 'vault-abc-123');
    expect(link).not.toBeNull();
    expect(parseImportVaultLink(link as string)).toEqual({
      serverUrl: 'https://sync.example.com',
      vaultId: 'vault-abc-123',
    });
  });

  it('round-trips a url that has a path and a port', () => {
    const link = buildInviteLink('https://sync.example.com:8787/thoth/', 'v1');
    expect(parseImportVaultLink(link as string)).toEqual({
      serverUrl: 'https://sync.example.com:8787/thoth',
      vaultId: 'v1',
    });
  });

  it('never carries the API key', () => {
    // A link that granted access would turn any forwarded invite into a
    // permanent, unexpirable grant. The joining device registers itself.
    const link = buildInviteLink('https://sync.example.com', 'vault-1') as string;
    expect(link).not.toContain('apiKey');
    expect(link).not.toContain('key=');
    expect(parseImportVaultLink(link)).toEqual({
      serverUrl: 'https://sync.example.com',
      vaultId: 'vault-1',
    });
  });

  it('refuses to build a partial link', () => {
    // A half-filled link parses as invalid on the other device, which reads as
    // a broken invite rather than an incomplete one.
    expect(buildInviteLink('', 'vault-1')).toBeNull();
    expect(buildInviteLink('https://sync.example.com', '')).toBeNull();
    expect(buildInviteLink('not a url', 'vault-1')).toBeNull();
  });

  it('keeps a full-length vault id intact', () => {
    // The settings tab used to display only the first 8 characters, so the id
    // could not be read or pasted at all.
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const parsed = parseImportVaultLink(
      buildInviteLink('https://sync.example.com', id) as string
    );
    expect(parsed?.vaultId).toBe(id);
    expect(parsed?.vaultId).toHaveLength(id.length);
  });
});
