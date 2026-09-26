import { describe, expect, it } from 'vitest';

import type { DurableObjectState } from '@cloudflare/workers-types';
import { MAX_ASSET_BYTES, type Operation } from '@thoth/protocol';

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
    for (const [k, v] of this.map.entries()) if (k.startsWith(prefix)) entries.set(k, v);
    return entries;
  }
}

function createDo() {
  const storage = new FakeStorage();
  return { doObject: new VaultDurableObject({ storage } as unknown as DurableObjectState), storage };
}

async function initVault(doObject: VaultDurableObject, id = 'vault-1'): Promise<void> {
  const res = await doObject.fetch(new Request('https://internal/init', { method: 'POST', body: JSON.stringify({ id }) }));
  expect(res.status).toBe(200);
}

describe('assets E2E', () => {
  it('uploads blob then pushes add-asset and snapshot contains asset', async () => {
    const { doObject } = createDo();
    await initVault(doObject);
    const assetId = encodeURIComponent('img/photo.png');
    const data = new TextEncoder().encode('pngbytes').buffer;
    const putRes = await doObject.fetch(
      new Request(`https://internal/assets/${assetId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: data,
      })
    );
    expect(putRes.status).toBe(200);
    const { hash } = (await putRes.json()) as { hash: string };
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const op: Operation = {
      id: 'op-asset-0',
      type: 'add-asset',
      deviceId: 'dev-1',
      revision: 0,
      payload: { path: 'img/photo.png', assetId, hash, size: data.byteLength, mimeType: 'image/png' },
    };
    const pushRes = await doObject.fetch(
      new Request('https://internal/push', { method: 'POST', body: JSON.stringify({ baseRevision: 0, operations: [op] }) })
    );
    expect(pushRes.status).toBe(200);
    const snapRes = await doObject.fetch(new Request('https://internal/snapshot'));
    const snap = (await snapRes.json()) as { revision: number; files: Record<string, string>; assets: Record<string, unknown> };
    expect(snap.revision).toBe(1);
    expect(snap.assets['img/photo.png']).toMatchObject({ assetId, hash, size: data.byteLength });

    const getRes = await doObject.fetch(new Request(`https://internal/assets/${assetId}`));
    expect(getRes.status).toBe(200);
    const out = await getRes.arrayBuffer();
    expect(new Uint8Array(out)).toEqual(new Uint8Array(data));
  });

  it('pull returns add-asset and delete-asset renames asset', async () => {
    const { doObject } = createDo();
    await initVault(doObject);
    const assetId = encodeURIComponent('a.png');
    const data = new TextEncoder().encode('b').buffer;
    await doObject.fetch(new Request(`https://internal/assets/${assetId}`, { method: 'PUT', body: data }));
    const addOp: Operation = {
      id: 'op-1',
      type: 'add-asset',
      deviceId: 'dev-1',
      revision: 0,
      payload: { path: 'a.png', assetId, hash: 'h', size: 1 },
    };
    await doObject.fetch(new Request('https://internal/push', { method: 'POST', body: JSON.stringify({ baseRevision: 0, operations: [addOp] }) }));

    const renameOp: Operation = {
      id: 'op-2',
      type: 'rename-note',
      deviceId: 'dev-1',
      revision: 1,
      payload: { oldPath: 'a.png', newPath: 'b.png' },
    };
    const r2 = await doObject.fetch(new Request('https://internal/push', { method: 'POST', body: JSON.stringify({ baseRevision: 1, operations: [renameOp] }) }));
    expect(r2.status).toBe(200);

    const pull = await doObject.fetch(new Request('https://internal/pull', { method: 'POST', body: JSON.stringify({ sinceRevision: 0 }) }));
    const json = (await pull.json()) as { operations: Operation[] };
    expect(json.operations.map((o) => o.type)).toEqual(['add-asset', 'rename-note']);

    const snap = (await (await doObject.fetch(new Request('https://internal/snapshot'))).json()) as { assets: Record<string, unknown> };
    expect(snap.assets['b.png']).toBeDefined();
    expect(snap.assets['a.png']).toBeUndefined();
  });

  it('rejects delete-asset for missing path', async () => {
    const { doObject } = createDo();
    await initVault(doObject);
    const op: Operation = {
      id: 'op-del',
      type: 'delete-asset',
      deviceId: 'dev-1',
      revision: 0,
      payload: { path: 'missing.png', assetId: 'missing.png' },
    };
    const res = await doObject.fetch(new Request('https://internal/push', { method: 'POST', body: JSON.stringify({ baseRevision: 0, operations: [op] }) }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe('NOTE_NOT_FOUND');
  });
});

describe('asset deduplication', () => {
  const bytes = new TextEncoder().encode('identical bytes');

  async function put(
    doObject: VaultDurableObject,
    path: string,
    mime = 'application/octet-stream'
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await doObject.fetch(
      new Request(`https://internal/assets/${encodeURIComponent(path)}`, {
        method: 'PUT',
        headers: { 'Content-Type': mime },
        body: bytes.buffer,
      })
    );
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  }

  it('serves a deduplicated asset under the id the client asked for', async () => {
    const { doObject } = createDo();
    await initVault(doObject);

    const first = await put(doObject, 'img/a.png');
    expect(first.status).toBe(200);
    const firstId = encodeURIComponent('img/a.png');

    // Same bytes uploaded under a different path.
    const second = await put(doObject, 'img/copy.png');
    expect(second.status).toBe(200);
    const secondId = encodeURIComponent('img/copy.png');

    // The server reports the duplicate, but must answer with the id the
    // client's add-asset operation references.
    expect(second.body.duplicate).toBe(true);
    expect(second.body.assetId).toBe(secondId);
    expect(second.body.canonicalAssetId).toBe(firstId);

    // The regression: the requested id was never registered, so every other
    // device got a 404 for an asset the snapshot pointed at.
    const res = await doObject.fetch(
      new Request(`https://internal/assets/${secondId}`)
    );
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it('shares one stored blob between duplicate ids', async () => {
    const { doObject, storage } = createDo();
    await initVault(doObject);

    await put(doObject, 'img/a.png');
    const afterFirst = [...storage.list({ prefix: 'asset-blob:' }).keys()];
    await put(doObject, 'img/copy.png');
    const afterSecond = [...storage.list({ prefix: 'asset-blob:' }).keys()];

    // Content-addressed storage means the duplicate costs no extra bytes.
    expect(afterSecond).toEqual(afterFirst);
    expect(afterFirst).toHaveLength(1);
  });

  it('keeps the requesting mime type on the alias', async () => {
    const { doObject } = createDo();
    await initVault(doObject);
    await put(doObject, 'img/a.bin', 'application/octet-stream');
    await put(doObject, 'img/a.png', 'image/png');

    const res = await doObject.fetch(
      new Request(`https://internal/assets/${encodeURIComponent('img/a.png')}`)
    );
    expect(res.headers.get('Content-Type')).toBe('image/png');
  });

  it('stores distinct content separately', async () => {
    const { doObject } = createDo();
    await initVault(doObject);
    await put(doObject, 'img/a.png');

    const other = new TextEncoder().encode('different bytes');
    const res = await doObject.fetch(
      new Request(`https://internal/assets/${encodeURIComponent('img/b.png')}`, {
        method: 'PUT',
        body: other.buffer,
      })
    );
    expect(res.status).toBe(200);
    expect((await res.json() as { duplicate?: boolean }).duplicate).toBeUndefined();
  });
});

describe('asset size limit', () => {
  it('rejects a blob above the shared limit with a clear status', async () => {
    const { doObject, storage } = createDo();
    await initVault(doObject);

    const oversized = new ArrayBuffer(MAX_ASSET_BYTES + 1);
    const res = await doObject.fetch(
      new Request('https://internal/assets/big.bin', {
        method: 'PUT',
        body: oversized,
      })
    );

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('ASSET_TOO_LARGE');
    // Nothing was written, so the plugin does not retry forever.
    expect([...storage.list({ prefix: 'asset-blob:' }).keys()]).toHaveLength(0);
  });

  it('accepts a blob at the limit', async () => {
    const { doObject } = createDo();
    await initVault(doObject);

    const res = await doObject.fetch(
      new Request('https://internal/assets/at-limit.bin', {
        method: 'PUT',
        body: new ArrayBuffer(MAX_ASSET_BYTES),
      })
    );
    expect(res.status).toBe(200);
  });
});
