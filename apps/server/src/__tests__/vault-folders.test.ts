import { describe, expect, it } from 'vitest';

import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Operation, OperationType } from '@thoth/protocol';

import { VaultDurableObject } from '../durable-objects/vault.js';

/**
 * Folder state end to end.
 *
 * A folder is invisible in a vault modelled as paths: it exists nowhere in the
 * file map, so a folder the user created and left empty simply did not exist
 * as far as any other device was concerned. The snapshot now carries those
 * paths, which is the only thing that makes them survive — and it is the
 * server that has to hold and hand them back.
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

function createDo() {
  const storage = new FakeStorage();
  const doObject = new VaultDurableObject({
    storage,
  } as unknown as DurableObjectState);
  return { doObject, storage };
}

async function initVault(doObject: VaultDurableObject): Promise<void> {
  const res = await doObject.fetch(
    new Request('https://internal/init', {
      method: 'POST',
      body: JSON.stringify({ id: 'vault-1' }),
    })
  );
  expect(res.status).toBe(200);
}

function folderOp(
  type: Extract<OperationType, 'create-folder' | 'delete-folder'>,
  revision: number,
  path: string
): Operation {
  return {
    id: `op-${type}-${revision}`,
    type,
    deviceId: 'dev-1',
    revision,
    payload: { path },
  };
}

function createNote(revision: number, path: string, content: string): Operation {
  return {
    id: `op-create-${revision}`,
    type: 'create-note',
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

function snapshotOf(doObject: VaultDurableObject): Promise<Response> {
  return doObject.fetch(new Request('https://internal/snapshot'));
}

describe('folder operations', () => {
  it('applies a folder creation and hands it back in the snapshot', async () => {
    const { doObject } = createDo();
    await initVault(doObject);

    const res = await push(doObject, 0, [folderOp('create-folder', 0, 'archive')]);
    expect(res.status).toBe(200);

    const snap = (await (await snapshotOf(doObject)).json()) as {
      revision: number;
      folders: string[];
    };
    expect(snap.revision).toBe(1);
    expect(snap.folders).toEqual(['archive']);
  });

  it('applies a folder deletion', async () => {
    const { doObject } = createDo();
    await initVault(doObject);
    await push(doObject, 0, [folderOp('create-folder', 0, 'archive')]);

    const res = await push(doObject, 1, [folderOp('delete-folder', 1, 'archive')]);
    expect(res.status).toBe(200);

    const snap = (await (await snapshotOf(doObject)).json()) as {
      folders: string[];
    };
    expect(snap.folders).toEqual([]);
  });

  it('accepts a batch of both operations in one push', async () => {
    const { doObject } = createDo();
    await initVault(doObject);

    const res = await push(doObject, 0, [
      folderOp('create-folder', 0, 'archive'),
      folderOp('create-folder', 1, 'notes/empty'),
      folderOp('delete-folder', 2, 'archive'),
    ]);
    expect(res.status).toBe(200);

    const snap = (await (await snapshotOf(doObject)).json()) as {
      folders: string[];
    };
    expect(snap.folders).toEqual(['notes/empty']);
  });

  it('keeps a folder whose only note was deleted, as Obsidian does', async () => {
    const { doObject } = createDo();
    await initVault(doObject);
    await push(doObject, 0, [
      folderOp('create-folder', 0, 'archive'),
      createNote(1, 'archive/a.md', 'a'),
    ]);

    const res = await push(doObject, 2, [
      {
        id: 'op-delete-note',
        type: 'delete-note',
        deviceId: 'dev-1',
        revision: 2,
        payload: { path: 'archive/a.md' },
      },
    ]);
    expect(res.status).toBe(200);

    const snap = (await (await snapshotOf(doObject)).json()) as {
      files: Record<string, string>;
      folders: string[];
    };
    // Deleting the last note leaves the empty folder standing on every
    // device, which is what the local vault does too.
    expect(snap.files).toEqual({});
    expect(snap.folders).toEqual(['archive']);
  });

  it('survives a restart, rather than living only in the log', async () => {
    const { doObject, storage } = createDo();
    await initVault(doObject);
    await push(doObject, 0, [folderOp('create-folder', 0, 'archive')]);

    const reopened = new VaultDurableObject({
      storage,
    } as unknown as DurableObjectState);
    const snap = (await (await snapshotOf(reopened)).json()) as {
      folders: string[];
    };
    expect(snap.folders).toEqual(['archive']);
  });

  it('serves a vault whose stored snapshot predates the folders field', async () => {
    const { doObject, storage } = createDo();
    await initVault(doObject);
    // Written by a version that had no folders to store.
    storage.put('vault', {
      metadata: { id: 'vault-1', devices: {} },
      log: { baseRevision: 0, operations: [] },
      snapshot: { revision: 2, files: { 'a.md': 'hello' }, assets: {} },
      assets: {},
    });

    const snap = (await (await snapshotOf(doObject)).json()) as {
      revision: number;
      files: Record<string, string>;
      folders: string[];
    };
    expect(snap.revision).toBe(2);
    expect(snap.files).toEqual({ 'a.md': 'hello' });
    // Defaulted, not undefined: a client reading `folders` must not have to
    // handle a missing field on a snapshot the server itself produced.
    expect(snap.folders).toEqual([]);
  });

  it('accepts a pushed snapshot that carries no folders field', async () => {
    const { doObject } = createDo();
    await initVault(doObject);

    const res = await doObject.fetch(
      new Request('https://internal/snapshot', {
        method: 'POST',
        body: JSON.stringify({ revision: 1, files: { 'a.md': 'hello' } }),
      })
    );
    expect(res.status).toBe(200);

    const snap = (await (await snapshotOf(doObject)).json()) as {
      folders: string[];
    };
    expect(snap.folders).toEqual([]);
  });
});

describe('capability negotiation', () => {
  it('advertises folders on both push and pull', async () => {
    // The gate this whole feature depends on: a client must be able to learn
    // the server accepts folder operations before emitting any.
    const { doObject } = createDo();
    await initVault(doObject);

    const pushed = (await (
      await push(doObject, 0, [folderOp('create-folder', 0, 'archive')])
    ).json()) as { capabilities?: string[] };
    expect(pushed.capabilities).toContain('folders');

    const pulled = (await (
      await doObject.fetch(
        new Request('https://internal/pull', {
          method: 'POST',
          body: JSON.stringify({ sinceRevision: 0 }),
        })
      )
    ).json()) as { capabilities?: string[] };
    expect(pulled.capabilities).toContain('folders');
  });
});