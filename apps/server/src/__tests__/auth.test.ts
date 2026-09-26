import { describe, expect, it } from 'vitest';

import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Operation } from '@thoth/protocol';

import { VaultDurableObject } from '../durable-objects/vault.js';

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

/** The register endpoint only accepts a strict UUID as a requested id. */
const DEVICE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function createNote(revision: number, path: string, content: string): Operation {
  return {
    id: `op-${path}`,
    type: 'create-note',
    deviceId: 'dev-1',
    revision,
    payload: { path, content },
  };
}

/** Creates a vault and registers a device, returning its API key. */
async function vaultWithDevice(): Promise<{
  doObject: VaultDurableObject;
  apiKey: string;
  deviceId: string;
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
      body: JSON.stringify({ deviceId: DEVICE_ID, name: 'Test' }),
    })
  );
  const body = (await res.json()) as { deviceId: string; apiKey: string };
  return { doObject, apiKey: body.apiKey, deviceId: body.deviceId };
}

function authed(
  path: string,
  method: string,
  apiKey: string,
  body?: unknown
): Request {
  return new Request(`https://internal${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('device authentication', () => {
  it('rejects a push with no credential', async () => {
    const { doObject } = await vaultWithDevice();
    const res = await doObject.fetch(
      new Request('https://internal/push', {
        method: 'POST',
        body: JSON.stringify({
          baseRevision: 0,
          operations: [createNote(0, 'a.md', 'a')],
        }),
      })
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('UNAUTHORIZED');
  });

  it('rejects a push with an unknown credential', async () => {
    const { doObject } = await vaultWithDevice();
    const res = await doObject.fetch(
      authed('/push', 'POST', 'not-a-real-key', {
        baseRevision: 0,
        operations: [createNote(0, 'a.md', 'a')],
      })
    );
    expect(res.status).toBe(401);
  });

  it('accepts a push with a valid credential', async () => {
    const { doObject, apiKey } = await vaultWithDevice();
    const res = await doObject.fetch(
      authed('/push', 'POST', apiKey, {
        baseRevision: 0,
        operations: [createNote(0, 'a.md', 'a')],
      })
    );
    expect(res.status).toBe(200);
  });

  it('guards the read paths that expose vault content', async () => {
    const { doObject, apiKey } = await vaultWithDevice();
    await doObject.fetch(
      authed('/push', 'POST', apiKey, {
        baseRevision: 0,
        operations: [createNote(0, 'secret.md', 'classified')],
      })
    );

    for (const [path, method] of [
      ['/pull', 'POST'],
      ['/snapshot', 'GET'],
      ['/metadata', 'GET'],
      ['/devices', 'GET'],
    ] as const) {
      const res = await doObject.fetch(
        new Request(`https://internal${path}`, {
          method,
          ...(method === 'POST'
            ? { body: JSON.stringify({ sinceRevision: 0 }) }
            : {}),
        })
      );
      expect(res.status, `${path} must require a credential`).toBe(401);
    }
  });

  it('guards the paths that change vault state', async () => {
    const { doObject } = await vaultWithDevice();

    const snapshot = await doObject.fetch(
      new Request('https://internal/snapshot', {
        method: 'POST',
        body: JSON.stringify({ revision: 99, files: {} }),
      })
    );
    expect(snapshot.status).toBe(401);

    const remove = await doObject.fetch(
      new Request(`https://internal/devices/${DEVICE_ID}`, { method: 'DELETE' })
    );
    expect(remove.status).toBe(401);

    const rotate = await doObject.fetch(
      new Request(`https://internal/devices/${DEVICE_ID}/rotate`, { method: 'POST' })
    );
    expect(rotate.status).toBe(401);
  });

  it('guards asset upload and download', async () => {
    const { doObject, apiKey } = await vaultWithDevice();
    const body = new TextEncoder().encode('bytes').buffer as ArrayBuffer;

    const put = await doObject.fetch(
      new Request('https://internal/assets/a.png', { method: 'PUT', body })
    );
    expect(put.status).toBe(401);

    await doObject.fetch(
      new Request('https://internal/assets/a.png', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${apiKey}` },
        body,
      })
    );

    const get = await doObject.fetch(
      new Request('https://internal/assets/a.png')
    );
    expect(get.status).toBe(401);
  });

  it('leaves a vault with no registered device open for bootstrap', async () => {
    // A device cannot present a key before it registers one, so requiring
    // one here would make the setup wizard impossible.
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
      new Request('https://internal/push', {
        method: 'POST',
        body: JSON.stringify({
          baseRevision: 0,
          operations: [createNote(0, 'first.md', 'first')],
        }),
      })
    );
    expect(res.status).toBe(200);
  });

  it('locks a legacy vault as soon as a device registers', async () => {
    const doObject = new VaultDurableObject({
      storage: new FakeStorage(),
    } as unknown as DurableObjectState);
    await doObject.fetch(
      new Request('https://internal/init', {
        method: 'POST',
        body: JSON.stringify({ id: 'legacy' }),
      })
    );
    // Pre-existing content, written before authentication existed.
    await doObject.fetch(
      new Request('https://internal/push', {
        method: 'POST',
        body: JSON.stringify({
          baseRevision: 0,
          operations: [createNote(0, 'old.md', 'old')],
        }),
      })
    );

    // Still open until a credential exists to check against.
    const before = await doObject.fetch(
      new Request('https://internal/snapshot')
    );
    expect(before.status).toBe(200);

    const reg = await doObject.fetch(
      new Request('https://internal/devices', {
        method: 'POST',
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      })
    );
    const { apiKey } = (await reg.json()) as { apiKey: string };

    // Now protected, and the existing content is intact.
    const after = await doObject.fetch(
      new Request('https://internal/snapshot')
    );
    expect(after.status).toBe(401);

    const withCred = await doObject.fetch(
      authed('/snapshot', 'GET', apiKey)
    );
    expect(withCred.status).toBe(200);
    const files = (await withCred.json()) as { files: Record<string, string> };
    expect(files.files['old.md']).toBe('old');
  });

  it('invalidates a credential once its device is removed', async () => {
    const { doObject, apiKey } = await vaultWithDevice();
    const before = await doObject.fetch(authed('/push', 'POST', apiKey, {
      baseRevision: 0,
      operations: [createNote(0, 'a.md', 'a')],
    }));
    expect(before.status).toBe(200);

    const removed = await doObject.fetch(
      authed(`/devices/${DEVICE_ID}`, 'DELETE', apiKey)
    );
    expect(removed.status).toBe(204);

    const after = await doObject.fetch(authed('/pull', 'POST', apiKey, { sinceRevision: 0 }));
    // The vault is open again rather than rejecting a now-unknown key, which
    // keeps a removed device from being locked out of re-registering.
    expect(after.status).toBe(200);
  });

  it('accepts a rotated credential and rejects the old one', async () => {
    const { doObject, apiKey } = await vaultWithDevice();

    const rotate = await doObject.fetch(
      authed(`/devices/${DEVICE_ID}/rotate`, 'POST', apiKey)
    );
    expect(rotate.status).toBe(200);
    const { apiKey: rotated } = (await rotate.json()) as { apiKey: string };

    const withNew = await doObject.fetch(authed('/pull', 'POST', rotated, { sinceRevision: 0 }));
    expect(withNew.status).toBe(200);

    const withOld = await doObject.fetch(authed('/pull', 'POST', apiKey, { sinceRevision: 0 }));
    expect(withOld.status).toBe(401);
  });
});
