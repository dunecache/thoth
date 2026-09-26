import { describe, expect, it } from 'vitest';

import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Operation } from '@thoth/protocol';

import { VaultDurableObject } from '../durable-objects/vault.js';

/** Minimal in-memory Durable Object storage for tests. */
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

function createDo() {
  const storage = new FakeStorage();
  const doObject = new VaultDurableObject({
    storage,
  } as unknown as DurableObjectState);
  return { doObject, storage };
}

async function initVault(
  doObject: VaultDurableObject,
  id = 'vault-1'
): Promise<void> {
  const res = await doObject.fetch(
    new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
  );
  expect(res.status).toBe(200);
}

function createNote(
  revision: number,
  path: string,
  content: string
): Operation {
  return {
    id: `op-create-${revision}`,
    type: 'create-note',
    deviceId: 'dev-1',
    revision,
    payload: { path, content },
  };
}

function replaceContent(
  revision: number,
  path: string,
  content: string
): Operation {
  return {
    id: `op-replace-${revision}`,
    type: 'replace-content',
    deviceId: 'dev-1',
    revision,
    payload: { path, content },
  };
}

async function push(
  doObject: VaultDurableObject,
  baseRevision: number,
  operations: Operation[]
): Promise<Response> {
  return doObject.fetch(
    new Request('https://internal/push', {
      method: 'POST',
      body: JSON.stringify({ baseRevision, operations }),
    })
  );
}

async function pull(
  doObject: VaultDurableObject,
  sinceRevision: number
): Promise<Response> {
  return doObject.fetch(
    new Request('https://internal/pull', {
      method: 'POST',
      body: JSON.stringify({ sinceRevision }),
    })
  );
}

describe('push', () => {
  it('applies a batch and returns the new revision', async () => {
    const { doObject } = createDo();
    await initVault(doObject);

    const res = await push(doObject, 0, [
      createNote(0, 'notes/a.md', 'hello'),
      replaceContent(1, 'notes/a.md', 'edited'),
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revision).toBe(2);

    const meta = await doObject.fetch(new Request('https://internal/metadata'));
    expect(await meta.json()).toEqual({ id: 'vault-1', revision: 2 });
  });

  it('rejects a push with a mismatched base revision', async () => {
    const { doObject } = createDo();
    await initVault(doObject);
    await push(doObject, 0, [createNote(0, 'a.md', 'x')]);

    const res = await push(doObject, 0, [createNote(0, 'b.md', 'y')]);
    expect(res.status).toBe(409);
    const json = (await res.json()) as {
      error: string;
      details: { revision: number };
    };
    expect(json.error).toBe('REVISION_MISMATCH');
    expect(json.details.revision).toBe(1);
  });

  it('returns the current revision on conflict for retry workflows', async () => {
    const { doObject } = createDo();
    await initVault(doObject);

    const res = await push(doObject, 5, [createNote(5, 'a.md', 'x')]);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { details: { revision: number } };
    expect(json.details.revision).toBe(0);
  });

  it('rejects operations that cannot apply to the server state', async () => {
    const { doObject } = createDo();
    await initVault(doObject);

    const res = await push(doObject, 0, [
      {
        id: 'op-del-0',
        type: 'delete-note',
        deviceId: 'dev-1',
        revision: 0,
        payload: { path: 'missing.md' },
      },
    ]);
    expect(res.status).toBe(409);
    const json = (await res.json()) as {
      error: string;
      details: { reason: string };
    };
    expect(json.error).toBe('CONFLICT');
    expect(json.details.reason).toBe('NOTE_NOT_FOUND');
  });

  it('rejects malformed request bodies with validation errors', async () => {
    const { doObject } = createDo();
    await initVault(doObject);

    const res = await push(doObject, 0, 'nope' as unknown as Operation[]);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('VALIDATION_ERROR');
  });

  it('persists pushed operations across restarts', async () => {
    const { doObject, storage } = createDo();
    await initVault(doObject);
    await push(doObject, 0, [createNote(0, 'notes/a.md', 'hello')]);

    // Simulate a DO restart by loading the same storage.
    const restarted = new VaultDurableObject({
      storage,
    } as unknown as DurableObjectState);
    const meta = await restarted.fetch(
      new Request('https://internal/metadata')
    );
    expect(await meta.json()).toEqual({ id: 'vault-1', revision: 1 });
  });
});

describe('pull', () => {
  it('returns the full log for a fresh device (sinceRevision 0)', async () => {
    const { doObject } = createDo();
    await initVault(doObject);
    await push(doObject, 0, [
      createNote(0, 'notes/a.md', 'hello'),
      replaceContent(1, 'notes/a.md', 'edited'),
    ]);

    const res = await pull(doObject, 0);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      revision: number;
      operations: Operation[];
    };
    expect(json.revision).toBe(2);
    expect(json.operations).toEqual([
      createNote(0, 'notes/a.md', 'hello'),
      replaceContent(1, 'notes/a.md', 'edited'),
    ]);
  });

  it('returns missing operations at and after a revision', async () => {
    const { doObject } = createDo();
    await initVault(doObject);
    await push(doObject, 0, [
      createNote(0, 'notes/a.md', 'hello'),
      replaceContent(1, 'notes/a.md', 'edited'),
    ]);

    const res = await pull(doObject, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      revision: 2,
      operations: [replaceContent(1, 'notes/a.md', 'edited')],
      hasMore: false,
      nextRevision: 2,
    });
  });

  it('returns an empty list when up to date', async () => {
    const { doObject } = createDo();
    await initVault(doObject);
    await push(doObject, 0, [createNote(0, 'notes/a.md', 'hello')]);

    const res = await pull(doObject, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      revision: 1,
      operations: [],
      hasMore: false,
    });
  });

  it('rejects malformed request bodies with validation errors', async () => {
    const { doObject } = createDo();
    await initVault(doObject);

    const res = await pull(doObject, -1);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('VALIDATION_ERROR');
  });
});

describe('ws-ticket', () => {
  it('issues a ticket for a valid device', async () => {
    const { doObject } = createDo();
    await initVault(doObject);
    // Register device via existing device route
    const deviceId = '11111111-1111-4111-8111-111111111111';
    const regRes = await doObject.fetch(
      new Request('https://internal/devices', {
        method: 'POST',
        body: JSON.stringify({ deviceId, name: 'test' }),
      })
    );
    expect(regRes.status).toBe(201);
    const { apiKey } = (await regRes.json()) as { apiKey: string };
    const ticketRes = await doObject.fetch(
      new Request('https://internal/ws-ticket', {
        method: 'POST',
        body: JSON.stringify({ deviceId, apiKey }),
      })
    );
    expect(ticketRes.status).toBe(201);
    const body = (await ticketRes.json()) as { ticket: string };
    expect(typeof body.ticket).toBe('string');
    expect(body.ticket.length).toBeGreaterThan(0);
  });

  it('rejects an invalid api key', async () => {
    const { doObject } = createDo();
    await initVault(doObject);
    const deviceId = '11111111-1111-4111-8111-111111111111';
    await doObject.fetch(
      new Request('https://internal/devices', {
        method: 'POST',
        body: JSON.stringify({ deviceId }),
      })
    );
    const ticketRes = await doObject.fetch(
      new Request('https://internal/ws-ticket', {
        method: 'POST',
        body: JSON.stringify({ deviceId, apiKey: 'wrong' }),
      })
    );
    expect(ticketRes.status).toBe(401);
  });

  it('single-use ticket cannot be replayed', async () => {
    const { doObject, storage } = createDo();
    await initVault(doObject);
    const deviceId = '11111111-1111-4111-8111-111111111111';
    const regRes = await doObject.fetch(
      new Request('https://internal/devices', {
        method: 'POST',
        body: JSON.stringify({ deviceId }),
      })
    );
    const { apiKey } = (await regRes.json()) as { apiKey: string };
    const t1 = await doObject.fetch(
      new Request('https://internal/ws-ticket', {
        method: 'POST',
        body: JSON.stringify({ deviceId, apiKey }),
      })
    );
    const { ticket } = (await t1.json()) as { ticket: string };
    // Simulate use by deleting ticket
    storage.delete(`ws-ticket:${ticket}`);
    const stored = storage.get(`ws-ticket:${ticket}`);
    expect(stored).toBeUndefined();
  });

  it('rejects expired ticket', async () => {
    const { doObject, storage } = createDo();
    await initVault(doObject);
    const deviceId = '11111111-1111-4111-8111-111111111111';
    const regRes = await doObject.fetch(
      new Request('https://internal/devices', {
        method: 'POST',
        body: JSON.stringify({ deviceId }),
      })
    );
    const { apiKey } = (await regRes.json()) as { apiKey: string };
    const t1 = await doObject.fetch(
      new Request('https://internal/ws-ticket', {
        method: 'POST',
        body: JSON.stringify({ deviceId, apiKey }),
      })
    );
    const { ticket } = (await t1.json()) as { ticket: string };
    const entry = storage.get<{ deviceId: string; expiresAt: number }>(
      `ws-ticket:${ticket}`
    );
    if (entry) {
      storage.put(`ws-ticket:${ticket}`, {
        ...entry,
        expiresAt: Date.now() - 1,
      });
    }
    const upgradeRes = await doObject.fetch(
      new Request(`https://internal/ws?deviceId=${deviceId}&ticket=${ticket}`)
    );
    expect(upgradeRes.status).toBe(401);
  });
});
