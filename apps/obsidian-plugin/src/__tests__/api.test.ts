import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkHealth, testAuthentication } from '../api.js';

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
