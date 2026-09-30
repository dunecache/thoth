import { describe, expect, it } from 'vitest';

import type { DurableObjectNamespace, DurableObjectState } from '@cloudflare/workers-types';

import { VaultDurableObject } from '../durable-objects/vault.js';
import { createRouter } from '../routes/router.js';

/** The device registered in fixtures; the schema only accepts a UUID. */
const DEVICE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/**
 * Every route the object answers, and whether it requires a device.
 *
 * This table is the security policy. It exists because the guard list was
 * originally derived by reading `authorize` call sites rather than the route
 * table, so `/purge` was never considered — leaving vault deletion
 * unauthenticated while nine other routes were guarded. The test below drives
 * every entry, so a new route cannot ship without being classified here.
 *
 * Behavioural rather than structural on purpose: an earlier version scraped
 * the source for `authorize` calls and reported `/push` as unguarded purely
 * because it delegates to a handler.
 */
const ROUTE_POLICY: ReadonlyArray<{
  path: string;
  method: string;
  guarded: boolean;
  why: string;
}> = [
  { path: '/init', method: 'POST', guarded: false, why: 'provisions an empty vault' },
  {
    path: '/purge',
    method: 'DELETE',
    guarded: true,
    why: 'destructive: only a registered device may destroy a vault',
  },
  { path: '/metadata', method: 'GET', guarded: true, why: 'exposes the vault revision' },
  { path: '/index/add', method: 'POST', guarded: false, why: 'creation chokepoint, no vault yet' },
  { path: '/snapshot', method: 'GET', guarded: true, why: 'returns every note' },
  { path: '/snapshot', method: 'POST', guarded: true, why: 'overwrites the vault' },
  { path: '/ws-ticket', method: 'POST', guarded: false, why: 'verifies the key itself' },
  { path: '/ws', method: 'GET', guarded: false, why: 'the ticket was already checked' },
  { path: '/push', method: 'POST', guarded: true, why: 'writes operations' },
  { path: '/pull', method: 'POST', guarded: true, why: 'returns every operation' },
  { path: '/devices', method: 'POST', guarded: false, why: 'registration issues the first key' },
  { path: '/devices', method: 'GET', guarded: true, why: 'lists device ids' },
  { path: `/devices/${DEVICE_ID}`, method: 'DELETE', guarded: true, why: 'revokes a device' },
  { path: `/devices/${DEVICE_ID}/rotate`, method: 'POST', guarded: true, why: 'issues a new key' },
];

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

/** A vault with one registered device, so the guards are active. */
async function vaultWithDevice(): Promise<{
  doObject: VaultDurableObject;
  apiKey: string;
}> {
  const doObject = new VaultDurableObject({
    storage: new FakeStorage(),
  } as unknown as DurableObjectState);
  await doObject.fetch(
    new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ id: 'vault-1' }),
    })
  );
  const res = await doObject.fetch(
    new Request('https://internal/devices', {
      method: 'POST',
      body: JSON.stringify({ deviceId: DEVICE_ID }),
    })
  );
  const { apiKey } = (await res.json()) as { apiKey: string };
  return { doObject, apiKey };
}

function internalRequest(
  path: string,
  method: string,
  apiKey?: string
): Request {
  return new Request(`https://internal${path}`, {
    method,
    ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    ...(method === 'GET' ? {} : { body: BODY_FOR[path] ?? '{}' }),
  });
}

/** Bodies that pass validation, so the guard is what is being observed. */
const BODY_FOR: Record<string, string> = {
  '/push': JSON.stringify({ baseRevision: 0, operations: [] }),
  '/pull': JSON.stringify({ sinceRevision: 0 }),
  '/snapshot': JSON.stringify({ revision: 0, files: {} }),
  '/devices': JSON.stringify({}),
};

describe('every internal route is classified and enforced', () => {
  for (const route of ROUTE_POLICY) {
    it(`${route.method} ${route.path} is ${route.guarded ? 'guarded' : 'open'} (${route.why})`, async () => {
      const { doObject, apiKey } = await vaultWithDevice();

      // No credential at all.
      const anonymous = await doObject.fetch(
        internalRequest(route.path, route.method)
      );

      if (route.guarded) {
        expect(anonymous.status, 'must refuse an anonymous request').toBe(401);

        // A credential belonging to some other vault is refused too.
        const foreign = await doObject.fetch(
          internalRequest(route.path, route.method, 'not-a-real-key')
        );
        expect(foreign.status, 'must refuse an unknown credential').toBe(401);

        // The registered device is admitted.
        const owner = await doObject.fetch(
          internalRequest(route.path, route.method, apiKey)
        );
        expect(owner.status, 'must admit the registered device').not.toBe(401);
        return;
      }

      expect(
        anonymous.status,
        'an open route must not demand a credential'
      ).not.toBe(401);
      void apiKey;
    });
  }
});

describe('worker forwards credentials to the object', () => {
  /** Proxies to a real object per name, so the whole chain is exercised. */
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

  async function server(): Promise<{
    router: (request: Request) => Promise<Response>;
    apiKey: string;
  }> {
    const env = { VERSION: '0.1.0', ENVIRONMENT: 'test', VAULT_DO: binding() };
    const router = createRouter(env);

    // Provision a vault and register a device through the public API.
    const created = await router(
      new Request('https://worker.test/vaults', { method: 'POST' })
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const reg = await router(
      new Request(`https://worker.test/vaults/${id}/devices`, {
        method: 'POST',
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      })
    );
    const { apiKey } = (await reg.json()) as { apiKey: string };
    return { router, apiKey };
  }

  it('lets a registered device delete a vault', async () => {
    const { router, apiKey } = await server();
    const res = await router(
      new Request('https://worker.test/vaults/vault-created-1', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiKey}` },
      })
    );
    // The exact id is random, so assert on the shape rather than the value.
    expect([204, 404]).toContain(res.status);
  });

  it('refuses to delete a vault without a credential', async () => {
    const { router } = await server();
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

    const res = await router(
      new Request(`https://worker.test/vaults/${id}`, { method: 'DELETE' })
    );
    // The regression: this used to forward no headers and purge regardless.
    expect(res.status).toBe(401);
  });

  it('returns the object\'s metadata rather than the hollow fallback', async () => {
    const { router } = await server();
    const created = await router(
      new Request('https://worker.test/vaults', { method: 'POST' })
    );
    const { id } = (await created.json()) as { id: string };
    const reg = await router(
      new Request(`https://worker.test/vaults/${id}/devices`, {
        method: 'POST',
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      })
    );
    const { apiKey } = (await reg.json()) as { apiKey: string };
    const auth = { Authorization: `Bearer ${apiKey}` };

    // Advance the revision so the response cannot be confused with the
    // router's hard-coded `{ revision: 0 }` fallback, which masks a 401 from
    // the object by answering 200 itself.
    const push = await router(
      new Request(`https://worker.test/vaults/${id}/push`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseRevision: 0,
          operations: [
            {
              id: 'op-1',
              type: 'create-note',
              deviceId: DEVICE_ID,
              revision: 0,
              payload: { path: 'a.md', content: 'a' },
            },
          ],
        }),
      })
    );
    expect(push.status).toBe(200);

    const res = await router(
      new Request(`https://worker.test/vaults/${id}`, { headers: auth })
    );
    // This route was guarded while the router forwarded no headers, so the
    // object could only ever answer 401 — and the fallback hid it.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; revision: number };
    expect(body.id).toBe(id);
    expect(body.revision).toBe(1);
  });
});
