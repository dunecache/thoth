import { describe, it, expect } from 'vitest';

import type { DurableObjectNamespace, DurableObjectState } from '@cloudflare/workers-types';

import { VaultDurableObject } from '../durable-objects/vault.js';
import { createRouter } from '../routes/router.js';

class FakeStorage {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  put(key: string, value: unknown): void {
    this.map.set(key, value);
  }
  delete(key: string): void {
    this.map.delete(key);
  }
  list(opts?: { prefix?: string }) {
    const prefix = opts?.prefix ?? '';
    const entries = new Map<string, unknown>();
    for (const [k, v] of this.map.entries()) {
      if (k.startsWith(prefix)) entries.set(k, v);
    }
    return entries;
  }
}

/** One object per name, so the shared creation chokepoint is shared. */
function fakeBinding(): DurableObjectNamespace {
  const objects = new Map<string, VaultDurableObject>();
  return {
    idFromName: (name: string) => name,
    get: (id: unknown) => {
      const name = String(id);
      let object = objects.get(name);
      if (!object) {
        object = new VaultDurableObject({
          storage: new FakeStorage(),
        } as unknown as DurableObjectState);
        objects.set(name, object);
      }
      return {
        fetch: (input: unknown, init?: RequestInit) =>
          object?.fetch(new Request(input as string, init)) as Promise<Response>,
      };
    },
  } as unknown as DurableObjectNamespace;
}

describe('router', () => {
  it('GET /health returns ok', async () => {
    const router = createRouter({ VERSION: '0.1.0', ENVIRONMENT: 'test' });
    const req = new Request('http://localhost/health');
    const res = await router(req);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json).toEqual({ status: 'ok' });
  });

  it('GET /version returns version', async () => {
    const router = createRouter({ VERSION: '0.1.0', ENVIRONMENT: 'test' });
    const req = new Request('http://localhost/version');
    const res = await router(req);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { version: string };
    expect(json).toEqual({ version: '0.1.0' });
  });

  it('unknown route returns 404', async () => {
    const router = createRouter({ VERSION: '0.1.0', ENVIRONMENT: 'test' });
    const req = new Request('http://localhost/unknown');
    const res = await router(req);
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('NOT_FOUND');
  });

  it('POST /vaults creates vault', async () => {
    // Storage must be configured: answering 201 while provisioning nothing
    // told the client a vault existed that did not.
    const router = createRouter({
      VERSION: '0.1.0',
      ENVIRONMENT: 'test',
      VAULT_DO: fakeBinding(),
    });
    const req = new Request('http://localhost/vaults', { method: 'POST' });
    const res = await router(req);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; revision: number };
    expect(json).toHaveProperty('id');
    expect(json.revision).toBe(0);
  });

  it('POST /vaults reports 503 when storage is not configured', async () => {
    const router = createRouter({ VERSION: '0.1.0', ENVIRONMENT: 'test' });
    const res = await router(
      new Request('http://localhost/vaults', { method: 'POST' })
    );
    expect(res.status).toBe(503);
  });

  it('GET /vaults/:id returns metadata', async () => {
    const router = createRouter({ VERSION: '0.1.0', ENVIRONMENT: 'test' });
    const req = new Request('http://localhost/vaults/123');
    const res = await router(req);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string };
    expect(json.id).toBe('123');
  });

  it('DELETE /vaults/:id returns 204', async () => {
    const router = createRouter({ VERSION: '0.1.0', ENVIRONMENT: 'test' });
    const req = new Request('http://localhost/vaults/123', {
      method: 'DELETE',
    });
    const res = await router(req);
    expect(res.status).toBe(204);
  });

  it('POST /vaults/:id/devices registers device', async () => {
    const router = createRouter({ VERSION: '0.1.0', ENVIRONMENT: 'test' });
    const req = new Request('http://localhost/vaults/123/devices', {
      method: 'POST',
    });
    const res = await router(req);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { deviceId: string; apiKey: string };
    expect(json).toHaveProperty('deviceId');
    expect(json).toHaveProperty('apiKey');
  });

  it('GET /vaults/:id/devices lists devices', async () => {
    const router = createRouter({ VERSION: '0.1.0', ENVIRONMENT: 'test' });
    const req = new Request('http://localhost/vaults/123/devices');
    const res = await router(req);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { devices: unknown[] };
    expect(json).toHaveProperty('devices');
  });

  it('DELETE /vaults/:id/devices/:deviceId removes device', async () => {
    const router = createRouter({ VERSION: '0.1.0', ENVIRONMENT: 'test' });
    const req = new Request('http://localhost/vaults/123/devices/abc', {
      method: 'DELETE',
    });
    const res = await router(req);
    expect(res.status).toBe(204);
  });

  it('POST /vaults/:id/devices/:deviceId/rotate rotates api key', async () => {
    const router = createRouter({ VERSION: '0.1.0', ENVIRONMENT: 'test' });
    const req = new Request('http://localhost/vaults/123/devices/abc/rotate', {
      method: 'POST',
    });
    const res = await router(req);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { deviceId: string; apiKey: string };
    expect(json.deviceId).toBe('abc');
    expect(json).toHaveProperty('apiKey');
  });

  it('POST /vaults/:id/devices/:deviceId/validate validates api key', async () => {
    const router = createRouter({ VERSION: '0.1.0', ENVIRONMENT: 'test' });
    const req = new Request(
      'http://localhost/vaults/123/devices/abc/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: 'test' }),
      }
    );
    const res = await router(req);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { valid: boolean };
    expect(json).toHaveProperty('valid');
  });

  it('POST /vaults/:id/push requires the DO binding', async () => {
    const router = createRouter({ VERSION: '0.1.0', ENVIRONMENT: 'test' });
    const req = new Request('http://localhost/vaults/123/push', {
      method: 'POST',
      body: JSON.stringify({ baseRevision: 0, operations: [] }),
    });
    const res = await router(req);
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('INTERNAL_ERROR');
  });

  it('POST /vaults/:id/pull requires the DO binding', async () => {
    const router = createRouter({ VERSION: '0.1.0', ENVIRONMENT: 'test' });
    const req = new Request('http://localhost/vaults/123/pull', {
      method: 'POST',
      body: JSON.stringify({ sinceRevision: 0 }),
    });
    const res = await router(req);
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('INTERNAL_ERROR');
  });
});
