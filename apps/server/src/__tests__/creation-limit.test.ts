import { describe, expect, it } from 'vitest';

import type { DurableObjectState } from '@cloudflare/workers-types';

import { VaultDurableObject } from '../durable-objects/vault.js';
import { createRouter } from '../routes/router.js';

/**
 * Vault creation is the only unauthenticated route that provisions a durable
 * object. It therefore needs its own budget: bounding only the general limit
 * left it at the same 600/min that ordinary polling is allowed, which on the
 * free tier is hundreds of durable objects per minute per address, none of
 * which any user ever deletes.
 */

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

const IP = '203.0.113.9';

function createObject(): VaultDurableObject {
  return new VaultDurableObject({
    storage: new FakeStorage(),
  } as unknown as DurableObjectState);
}

describe('creation rate limit', () => {
  it('admits a small number of creations and then refuses', async () => {
    // The budget lives in the shared index object, which is the only object
    // every creation passes through; a fresh vault object always starts with
    // an empty bucket, so it can never bound anything.
    const chokepoint = createObject();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const res = await chokepoint.fetch(
        new Request('https://internal/index/reserve', {
          method: 'POST',
          headers: { 'cf-connecting-ip': IP },
          body: JSON.stringify({}),
        })
      );
      statuses.push(res.status);
    }
    // The budget is 5 per minute; the rest must be refused rather than each
    // one quietly provisioning another durable object.
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
  });

  it('reports a rate limit rather than a generic failure', async () => {
    const chokepoint = createObject();
    let last: Response | null = null;
    for (let i = 0; i < 7; i += 1) {
      last = await chokepoint.fetch(
        new Request('https://internal/index/reserve', {
          method: 'POST',
          headers: { 'cf-connecting-ip': IP },
          body: JSON.stringify({}),
        })
      );
    }
    expect(last?.status).toBe(429);
    const body = (await last?.json()) as { error: string; message: string };
    expect(body.error).toBe('TOO_MANY_REQUESTS');
    expect(body.message).toContain('5 requests per 60s');
  });

  it('keeps the creation budget separate from ordinary traffic', async () => {
    // Both budgets live in the same object here, which is the worst case: a
    // caller must not be able to spend its creation allowance on polling and
    // be refused for creating a vault, or the reverse.
    const chokepoint = createObject();
    const headers = { 'cf-connecting-ip': IP };

    for (let i = 0; i < 6; i += 1) {
      await chokepoint.fetch(
        new Request('https://internal/index/reserve', {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        })
      );
    }
    const refused = await chokepoint.fetch(
      new Request('https://internal/index/reserve', {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      })
    );
    expect(refused.status).toBe(429);

    // Ordinary routes must be unaffected, so a client that legitimately
    // polls and then hits a failed push still gets through.
    await chokepoint.fetch(
      new Request('https://internal/init', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: 'after-refusal' }),
      })
    );
    const metadata = await chokepoint.fetch(
      new Request('https://internal/metadata', { headers })
    );
    expect(metadata.status).toBe(200);
  });

  it('budgets per address, so one caller cannot exhaust another\'', async () => {
    const chokepoint = createObject();
    for (let i = 0; i < 6; i += 1) {
      await chokepoint.fetch(
        new Request('https://internal/index/reserve', {
          method: 'POST',
          headers: { 'cf-connecting-ip': '198.51.100.1' },
          body: JSON.stringify({}),
        })
      );
    }
    const blocked = await chokepoint.fetch(
      new Request('https://internal/index/reserve', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '198.51.100.1' },
        body: JSON.stringify({}),
      })
    );
    expect(blocked.status).toBe(429);

    const other = await chokepoint.fetch(
      new Request('https://internal/index/reserve', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '198.51.100.2' },
        body: JSON.stringify({}),
      })
    );
    expect(other.status).toBe(200);
  });
});

describe('worker vault creation', () => {
  function binding() {
    const objects = new Map<string, VaultDurableObject>();
    return {
      idFromName: (name: string) => name,
      get: (id: unknown) => {
        const name = String(id);
        let object = objects.get(name);
        if (!object) {
          object = createObject();
          objects.set(name, object);
        }
        return {
          fetch: (input: unknown, init?: RequestInit) =>
            object?.fetch(new Request(input as string, init)) as Promise<Response>,
        };
      },
    };
  }

  it('refuses to report success when storage is not configured', async () => {
    // No VAULT_DO binding: the old code returned 201 with a fresh id and
    // silently created nothing.
    const router = createRouter({ VERSION: '0.1.0', ENVIRONMENT: 'test' });
    const res = await router(
      new Request('https://worker.test/vaults', { method: 'POST' })
    );
    expect(res.status).toBe(503);
  });

  it('forwards the caller address so the budget is per-IP', async () => {
    const router = createRouter({
      VERSION: '0.1.0',
      ENVIRONMENT: 'test',
      VAULT_DO: binding() as never,
    });

    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await router(
        new Request('https://worker.test/vaults', {
          method: 'POST',
          headers: { 'cf-connecting-ip': IP },
        })
      );
      statuses.push(res.status);
    }
    // Without the address being forwarded the object saw 'unknown' and could
    // not tell callers apart at all.
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
  });

  it('reports the limit to the caller rather than a hollow 201', async () => {
    const router = createRouter({
      VERSION: '0.1.0',
      ENVIRONMENT: 'test',
      VAULT_DO: binding() as never,
    });
    let limited: Response | null = null;
    for (let i = 0; i < 7; i += 1) {
      const res = await router(
        new Request('https://worker.test/vaults', {
          method: 'POST',
          headers: { 'cf-connecting-ip': IP },
        })
      );
      if (res.status === 429) {
        limited = res;
      }
    }
    expect(limited).not.toBeNull();
    const body = (await limited?.json()) as { error: string };
    expect(body.error).toBe('TOO_MANY_REQUESTS');
  });
});
