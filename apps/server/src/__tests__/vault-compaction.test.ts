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

interface StoredVaultShape {
  log: { baseRevision: number; operations: Operation[] };
  snapshot: { revision: number; files: Record<string, string> };
}

function createDo(storage = new FakeStorage()) {
  const doObject = new VaultDurableObject({
    storage,
  } as unknown as DurableObjectState);
  return { doObject, storage };
}

async function init(doObject: VaultDurableObject, id = 'vault-1'): Promise<void> {
  const res = await doObject.fetch(
    new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
  );
  expect(res.status).toBe(200);
}

function createNote(revision: number, path: string): Operation {
  return {
    id: `op-${revision}`,
    type: 'create-note',
    deviceId: 'dev-1',
    revision,
    payload: { path, content: `content ${revision}` },
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

async function pushInBatches(
  doObject: VaultDurableObject,
  total: number,
  batchSize = 100
): Promise<void> {
  for (let base = 0; base < total; base += batchSize) {
    const count = Math.min(batchSize, total - base);
    const operations = Array.from({ length: count }, (_, i) =>
      createNote(base + i, `note-${base + i}.md`)
    );
    const res = await push(doObject, base, operations);
    expect(res.status).toBe(200);
  }
}

async function readFiles(doObject: VaultDurableObject): Promise<string[]> {
  const res = await doObject.fetch(new Request('https://internal/snapshot'));
  const body = (await res.json()) as { files: Record<string, string> };
  return Object.keys(body.files).sort();
}

describe('compaction safety', () => {
  it('preserves the vault across compaction on a warm instance', async () => {
    const { doObject, storage } = createDo();
    await init(doObject);

    await pushInBatches(doObject, 500);
    // Compaction fired on the 500th operation.
    const afterPush = storage.get<StoredVaultShape>('vault');
    expect(afterPush?.log.operations.length).toBeLessThan(500);
    expect(afterPush?.snapshot.revision).toBe(500);

    // Any subsequent read must not rebuild the snapshot from the window.
    const files = await readFiles(doObject);
    expect(files).toHaveLength(500);
    expect(files).toContain('note-0.md');
    expect(files).toContain('note-250.md');
    expect(files).toContain('note-499.md');
  });

  it('preserves the vault when the instance is recreated after compaction', async () => {
    const storage = new FakeStorage();
    const first = createDo(storage).doObject;
    await init(first);
    await pushInBatches(first, 500);

    // A fresh instance stands in for eviction or a cold start.
    const revived = createDo(storage).doObject;
    const files = await readFiles(revived);
    expect(files).toHaveLength(500);

    const meta = await revived.fetch(new Request('https://internal/metadata'));
    expect(((await meta.json()) as { revision: number }).revision).toBe(500);
  });

  it('keeps accepting pushes after compaction', async () => {
    const { doObject } = createDo();
    await init(doObject);
    await pushInBatches(doObject, 500);

    const res = await push(doObject, 500, [createNote(500, 'after.md')]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revision: number }).revision).toBe(501);
    expect(await readFiles(doObject)).toHaveLength(501);
  });

  it('tells a client below the window to re-bootstrap from the snapshot', async () => {
    const { doObject } = createDo();
    await init(doObject);
    await pushInBatches(doObject, 500);

    const res = await doObject.fetch(
      new Request('https://internal/pull', {
        method: 'POST',
        body: JSON.stringify({ sinceRevision: 0 }),
      })
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as {
      error: string;
      details: { baseRevision: number; revision: number };
    };
    expect(body.error).toBe('HISTORY_TRUNCATED');
    expect(body.details.revision).toBe(500);
  });

  it('still serves clients inside the window incrementally', async () => {
    const { doObject, storage } = createDo();
    await init(doObject);
    await pushInBatches(doObject, 500);

    const base = storage.get<StoredVaultShape>('vault')?.log.baseRevision ?? 0;
    const res = await doObject.fetch(
      new Request('https://internal/pull', {
        method: 'POST',
        body: JSON.stringify({ sinceRevision: base }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { operations: Operation[] };
    expect(body.operations.length).toBeGreaterThan(0);
    expect(body.operations[0]?.revision).toBe(base);
  });

  it('rebuilds the snapshot only when a complete log proves it is stale', async () => {
    const storage = new FakeStorage();
    const { doObject } = createDo(storage);
    await init(doObject);
    await pushInBatches(doObject, 100);

    // Simulate a crash between acknowledging operations and folding them
    // into the snapshot: the log still holds complete history.
    const stored = storage.get<StoredVaultShape>('vault');
    if (!stored) throw new Error('expected persisted vault');
    stored.snapshot.revision = 40;
    storage.put('vault', stored);

    const revived = createDo(storage).doObject;
    const files = await readFiles(revived);
    expect(files).toHaveLength(100);
  });
});
