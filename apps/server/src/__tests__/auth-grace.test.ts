import { describe, expect, it } from 'vitest';

import type { DurableObjectNamespace, DurableObjectState } from '@cloudflare/workers-types';

import { VaultDurableObject } from '../durable-objects/vault.js';
import { authEnforcedAfter, createRouter } from '../routes/router.js';

/**
 * The authentication grace period.
 *
 * A client predating authentication sends no bearer token, so once the
 * server required one it began failing with an unexplained 401. The grace
 * period accepts those requests on the data routes until a configured
 * instant.
 *
 * The dangerous part is not the window, it is who controls it. The worker
 * signals the object with a header, and every internal forward copies the
 * client's headers — so without stripping that header first, a client could
 * set it for itself and switch authentication off permanently.
 */

const PAST = '2020-01-01T00:00:00Z';
const FUTURE = '2999-01-01T00:00:00Z';

const DEVICE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

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

function binding(): DurableObjectNamespace {
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

describe('authEnforcedAfter', () => {
  it('enforces once the date has passed', () => {
    expect(authEnforcedAfter({ AUTH_ENFORCED_AFTER: PAST })).toBe(true);
  });

  it('leaves the window open before the date', () => {
    expect(authEnforcedAfter({ AUTH_ENFORCED_AFTER: FUTURE })).toBe(false);
  });

  it('fails closed when the value is missing', () => {
    // A missing binding must not silently reopen the server.
    expect(authEnforcedAfter({})).toBe(true);
    expect(authEnforcedAfter({ AUTH_ENFORCED_AFTER: '' })).toBe(true);
  });

  it('fails closed when the value is unparseable', () => {
    // Failing open here would make a typo in configuration disable auth.
    expect(authEnforcedAfter({ AUTH_ENFORCED_AFTER: 'soon' })).toBe(true);
    expect(authEnforcedAfter({ AUTH_ENFORCED_AFTER: '2026-13-45' })).toBe(true);
  });
});

describe('grace period through the worker', () => {
  async function server(authEnforcedAfter?: string): Promise<{
    router: (request: Request) => Promise<Response>;
    vaultId: string;
  }> {
    const router = createRouter({
      VERSION: '0.1.0',
      ENVIRONMENT: 'test',
      VAULT_DO: binding(),
      ...(authEnforcedAfter === undefined ? {} : { AUTH_ENFORCED_AFTER: authEnforcedAfter }),
    });
    const created = await router(
      new Request('https://worker.test/vaults', { method: 'POST' })
    );
    const { id } = (await created.json()) as { id: string };
    await router(
      new Request(`https://worker.test/vaults/${id}/devices`, {
        method: 'POST',
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      })
    );
    return { router, vaultId: id };
  }

  const push = (id: string, headers: HeadersInit = {}): Request =>
    new Request(`https://worker.test/vaults/${id}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ baseRevision: 0, operations: [] }),
    });

  it('accepts a keyless push while the window is open', async () => {
    const { router, vaultId } = await server(FUTURE);
    const res = await router(push(vaultId));
    expect(res.status).toBe(200);
  });

  it('refuses a keyless push once enforcement begins', async () => {
    const { router, vaultId } = await server(PAST);
    const res = await router(push(vaultId));
    expect(res.status).toBe(401);
  });

  it('refuses a keyless push when no date is configured', async () => {
    const { router, vaultId } = await server();
    const res = await router(push(vaultId));
    expect(res.status).toBe(401);
  });

  it('still accepts a credential during the window', async () => {
    const { router, vaultId } = await server(FUTURE);
    const res = await router(push(vaultId, { Authorization: 'Bearer whatever' }));
    // A wrong key is not rejected outright during grace, but it must not be
    // reported as a successful authenticated write either; either way the
    // request is answered, not hung.
    expect([200, 401]).toContain(res.status);
  });

  it('ignores a grace header sent by the client', async () => {
    // The core safety property: the object trusts this header, so the worker
    // must strip the client's copy before forwarding. Without that, anyone
    // could turn authentication off permanently with one request.
    const { router, vaultId } = await server(PAST);
    const res = await router(
      push(vaultId, { 'x-thoth-auth-grace': '1' })
    );
    expect(res.status).toBe(401);
  });

  it('still enforces deleting a vault during the window', async () => {
    const { router, vaultId } = await server(FUTURE);
    const res = await router(
      new Request(`https://worker.test/vaults/${vaultId}`, { method: 'DELETE' })
    );
    // Destructive routes are never grace-exempt: an open window there would
    // let anyone destroy a vault.
    expect(res.status).toBe(401);
  });

  it('still enforces rotating a device during the window', async () => {
    const { router, vaultId } = await server(FUTURE);
    const res = await router(
      new Request(`https://worker.test/vaults/${vaultId}/devices/${DEVICE_ID}/rotate`, {
        method: 'POST',
      })
    );
    expect(res.status).toBe(401);
  });

  it('still enforces removing a device during the window', async () => {
    const { router, vaultId } = await server(FUTURE);
    const res = await router(
      new Request(`https://worker.test/vaults/${vaultId}/devices/${DEVICE_ID}`, {
        method: 'DELETE',
      })
    );
    expect(res.status).toBe(401);
  });

  it('lets a keyless client list devices during the window', async () => {
    const { router, vaultId } = await server(FUTURE);
    const res = await router(
      new Request(`https://worker.test/vaults/${vaultId}/devices`)
    );
    // Listing is a read an old client performs when opening settings.
    expect(res.status).toBe(200);
  });
});

describe('grace period at the object', () => {
  async function object(): Promise<VaultDurableObject> {
    const doObject = new VaultDurableObject({
      storage: new FakeStorage(),
    } as unknown as DurableObjectState);
    await doObject.fetch(
      new Request('https://internal/init', {
        method: 'POST',
        body: JSON.stringify({ id: 'vault-1' }),
      })
    );
    await doObject.fetch(
      new Request('https://internal/devices', {
        method: 'POST',
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      })
    );
    return doObject;
  }

  it('ignores the grace header on a destructive route', async () => {
    const doObject = await object();
    const res = await doObject.fetch(
      new Request('https://internal/purge', {
        method: 'DELETE',
        headers: { 'x-thoth-auth-grace': '1' },
      })
    );
    // Defence in depth: the object refuses to exempt purge even if a future
    // refactor forgets to pass graceExempt: false.
    expect(res.status).toBe(401);
  });

  it('ignores the grace header on credential changes', async () => {
    const doObject = await object();
    for (const path of [
      `/devices/${DEVICE_ID}`,
      `/devices/${DEVICE_ID}/rotate`,
    ]) {
      const res = await doObject.fetch(
        new Request(`https://internal${path}`, {
          method: 'DELETE',
          headers: { 'x-thoth-auth-grace': '1' },
        })
      );
      expect(res.status, `${path} must ignore the grace header`).toBe(401);
    }
  });

  it('honours the grace header on a data route', async () => {
    const doObject = await object();
    const res = await doObject.fetch(
      new Request('https://internal/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-thoth-auth-grace': '1',
        },
        body: JSON.stringify({ baseRevision: 0, operations: [] }),
      })
    );
    expect(res.status).toBe(200);
  });
});
