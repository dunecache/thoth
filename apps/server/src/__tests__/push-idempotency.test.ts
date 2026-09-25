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

async function newVault(id = 'vault-1'): Promise<VaultDurableObject> {
  const doObject = new VaultDurableObject({
    storage: new FakeStorage(),
  } as unknown as DurableObjectState);
  await doObject.fetch(
    new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
  );
  return doObject;
}

function createNote(revision: number, path: string, content: string): Operation {
  return {
    id: `op-${path}`,
    type: 'create-note',
    deviceId: 'dev-1',
    revision,
    payload: { path, content },
  };
}

function replaceContent(revision: number, path: string, content: string): Operation {
  return {
    id: `op-replace-${path}-${revision}`,
    type: 'replace-content',
    deviceId: 'dev-1',
    revision,
    payload: { path, content },
  };
}

function push(doObject: VaultDurableObject, body: unknown): Promise<Response> {
  return doObject.fetch(
    new Request('https://internal/push', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}

describe('push idempotency', () => {
  it('acknowledges a retried batch instead of rejecting it', async () => {
    const doObject = await newVault();
    const operations = [createNote(0, 'a.md', 'a')];

    const first = await push(doObject, { baseRevision: 0, operations });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { revision: number }).revision).toBe(1);

    // The response was lost in flight; the client re-sends the same batch
    // against the same, now stale, baseRevision.
    const retry = await push(doObject, { baseRevision: 0, operations });
    expect(retry.status).toBe(200);
    const body = (await retry.json()) as { revision: number; replayed?: boolean };
    expect(body.revision).toBe(1);
    expect(body.replayed).toBe(true);
  });

  it('does not apply a retried batch twice', async () => {
    const doObject = await newVault();
    const operations = [
      createNote(0, 'a.md', 'a'),
      replaceContent(1, 'a.md', 'edited'),
    ];
    await push(doObject, { baseRevision: 0, operations });
    await push(doObject, { baseRevision: 0, operations });

    const res = await doObject.fetch(new Request('https://internal/snapshot'));
    const body = (await res.json()) as {
      revision: number;
      files: Record<string, string>;
    };
    expect(body.revision).toBe(2);
    expect(body.files['a.md']).toBe('edited');
  });

  it('rejects a batch that reuses an id with different content', async () => {
    const doObject = await newVault();
    await push(doObject, {
      baseRevision: 0,
      operations: [createNote(0, 'a.md', 'original')],
    });

    // Same id, same revision slot, different payload: a genuine conflict.
    const res = await push(doObject, {
      baseRevision: 0,
      operations: [createNote(0, 'a.md', 'tampered')],
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('REVISION_MISMATCH');
  });

  it('rejects a partial overlap rather than silently skipping operations', async () => {
    const doObject = await newVault();
    await push(doObject, {
      baseRevision: 0,
      operations: [createNote(0, 'a.md', 'a')],
    });

    // Second op is new, first is a replay: not an exact replay of the log.
    const res = await push(doObject, {
      baseRevision: 0,
      operations: [createNote(0, 'a.md', 'a'), createNote(1, 'b.md', 'b')],
    });
    expect(res.status).toBe(409);
  });

  it('still rejects a genuinely stale baseRevision', async () => {
    const doObject = await newVault();
    await push(doObject, {
      baseRevision: 0,
      operations: [createNote(0, 'a.md', 'a')],
    });
    await push(doObject, {
      baseRevision: 1,
      operations: [replaceContent(1, 'a.md', 'b')],
    });

    // Correct ids and revisions for a batch the server never saw.
    const res = await push(doObject, {
      baseRevision: 1,
      operations: [createNote(1, 'c.md', 'c')],
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('REVISION_MISMATCH');
  });

  it('resumes correctly when a retry follows a lost response mid-batch', async () => {
    const doObject = await newVault();
    const batch = [createNote(0, 'a.md', 'a'), createNote(1, 'b.md', 'b')];

    const first = await push(doObject, { baseRevision: 0, operations: batch });
    expect(((await first.json()) as { revision: number }).revision).toBe(2);

    // Client retries the first half only, then re-drives the rest from the
    // revision the retry reported.
    const retryFirst = await push(doObject, {
      baseRevision: 0,
      operations: [batch[0] as Operation],
    });
    expect(retryFirst.status).toBe(200);
    const revision = ((await retryFirst.json()) as { revision: number }).revision;
    expect(revision).toBe(2);

    const next = await push(doObject, {
      baseRevision: revision,
      operations: [createNote(2, 'c.md', 'c')],
    });
    expect(next.status).toBe(200);
    expect(((await next.json()) as { revision: number }).revision).toBe(3);
  });
});
