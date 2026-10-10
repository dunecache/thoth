import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * An empty folder has to travel, or it does not exist.
 *
 * A vault modelled as file paths cannot express a folder: it appears in no
 * file map, so a folder the user created and left empty was simply absent as
 * far as every other device was concerned. Creating one on a phone left
 * nothing behind on a laptop, and deleting one left a ghost the user could
 * not get rid of.
 *
 * These tests pin the whole path: the listener emits one operation for the
 * folder, the engine records it, the snapshot carries it, and the applier
 * writes it back on the other device — including creating the ancestors a
 * nested folder implies, and staying silent when the server does not
 * understand folders at all.
 */

import { TFile, TFolder } from 'obsidian';
import type { Operation } from '@thoth/protocol';

import { createApplyGuard } from '../apply-guard.js';
import { changeToDraft } from '../change-detection.js';
import { planBootstrap } from '../bootstrap-plan.js';
import { OperationQueue } from '../queue.js';
import { downloadSnapshot } from '../sync-engine.js';
import { applyOperationToVault, applySnapshotToVault } from '../vault-applier.js';
import { createObsidianVaultAdapter } from '../vault-adapter.js';
import { attachVaultListener } from '../vault-listener.js';
import { MemoryVault } from '../test-support/memory-vault.js';
import type { OperationQueue as OperationQueueType } from '../queue.js';

function folderNode(path: string): TFolder {
  const folder = new TFolder();
  folder.path = path;
  folder.name = path.split('/').pop() ?? path;
  return folder;
}

function fileNode(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.name = path.split('/').pop() ?? path;
  const dot = file.name.lastIndexOf('.');
  file.extension = dot === -1 ? '' : file.name.slice(dot + 1);
  return file;
}

type VaultNode = TFolder | TFile;

function eventVault(): {
  vault: unknown;
  fire: (kind: string, file: VaultNode, oldPath?: string) => Promise<void>;
} {
  const handlers: Record<string, ((f: unknown, old?: string) => void)[]> = {};
  const vault = {
    on: (kind: string, fn: (f: unknown, old?: string) => void) => {
      (handlers[kind] ??= []).push(fn);
      return { kind, fn };
    },
    offref: () => {},
    read: async () => '',
    readBinary: async () => new ArrayBuffer(0),
    getAbstractFileByPath: () => null,
  };
  return {
    vault,
    fire: async (kind: string, file: VaultNode, oldPath?: string) => {
      for (const fn of handlers[kind] ?? []) fn(file, oldPath);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function fakeQueue(): { queue: OperationQueueType; drafts: Operation[] } {
  const drafts: Operation[] = [];
  const queue = {
    enqueue: async (draft: { type: string; payload: unknown }) => {
      drafts.push(draft as unknown as Operation);
      return draft as unknown as Operation;
    },
    size: drafts.length,
  } as unknown as OperationQueueType;
  return { queue, drafts };
}

function setupListener(canSyncFolders: boolean) {
  const { vault, fire } = eventVault();
  const { queue, drafts } = fakeQueue();
  const detach = attachVaultListener({
    vault: vault as never,
    queue,
    getDeviceId: () => 'device-1',
    getExtensions: () => ['md'],
    canSyncFolders: () => canSyncFolders,
  });
  return { fire, drafts, detach };
}

function folderOp(type: 'create-folder' | 'delete-folder', path: string): Operation {
  return {
    id: `op-${type}`,
    type,
    deviceId: 'd1',
    revision: 1,
    parentRevision: 0,
    payload: { path },
  } as Operation;
}

describe('changeToDraft for a folder', () => {
  it('maps a folder creation', () => {
    expect(changeToDraft({ kind: 'create-folder', path: 'archive' })).toEqual({
      type: 'create-folder',
      payload: { path: 'archive' },
    });
  });

  it('maps a folder deletion', () => {
    expect(changeToDraft({ kind: 'delete-folder', path: 'archive' })).toEqual({
      type: 'delete-folder',
      payload: { path: 'archive' },
    });
  });
});

describe('listener: folder create and delete', () => {
  it('emits create-folder when a folder is created', async () => {
    const { fire, drafts, detach } = setupListener(true);

    await fire('create', folderNode('archive'));

    expect(drafts).toEqual([
      { type: 'create-folder', payload: { path: 'archive' } },
    ]);
    detach();
  });

  it('emits the folder and the note that lands inside it', async () => {
    const { fire, drafts, detach } = setupListener(true);

    // What Obsidian reports when a note is created two levels deep.
    await fire('create', folderNode('notes'));
    await fire('create', folderNode('notes/deep'));
    await fire('create', fileNode('notes/deep/a.md'));

    // The note's path already implies its parents, so those two are
    // redundant — but harmless, and dropping them would leave a folder the
    // user emptied later with no record of ever having existed.
    expect(drafts.map((d) => d.type)).toEqual([
      'create-folder',
      'create-folder',
      'create-note',
    ]);
    detach();
  });

  it('emits delete-folder and still emits the deletes inside it', async () => {
    const { fire, drafts, detach } = setupListener(true);

    // Obsidian reports the folder and then every path it removed.
    await fire('delete', folderNode('archive'));
    await fire('delete', folderNode('archive/sub'));
    await fire('delete', fileNode('archive/a.md'));

    expect(drafts).toEqual([
      { type: 'delete-folder', payload: { path: 'archive' } },
      { type: 'delete-folder', payload: { path: 'archive/sub' } },
      { type: 'delete-note', payload: { path: 'archive/a.md' } },
    ]);
    detach();
  });

  it('emits nothing at all when the server does not understand folders', async () => {
    // The backward-compatibility gate. An older server rejects these types
    // outright, which fails the whole batch, so a client that has not seen
    // the capability must not produce them — the note operations still go.
    const { fire, drafts, detach } = setupListener(false);

    await fire('create', folderNode('archive'));
    await fire('delete', folderNode('gone'));

    expect(drafts).toEqual([]);
    detach();
  });

  it('still emits note operations when folders are unsupported', async () => {
    const { fire, drafts, detach } = setupListener(false);

    await fire('create', fileNode('archive/a.md'));
    await fire('delete', fileNode('archive/a.md'));

    expect(drafts.map((d) => d.type)).toEqual(['create-note', 'delete-note']);
    detach();
  });
});

describe('listener: a nested folder rename does not re-send the subtree', () => {
  it('drops the rename of a folder inside the folder just renamed', async () => {
    const { fire, drafts, detach } = setupListener(true);

    // Obsidian reports the folder, then each nested folder, then each file.
    await fire('rename', folderNode('archive-2024'), 'archive');
    await fire('rename', folderNode('archive-2024/deep'), 'archive/deep');
    await fire('rename', fileNode('archive-2024/a.md'), 'archive/a.md');
    await fire('rename', fileNode('archive-2024/deep/b.md'), 'archive/deep/b.md');

    // The second operation is not merely redundant: the first has already
    // moved `archive/deep/b.md` under its own target, so the engine rejects
    // it as TARGET_EXISTS and takes the whole batch with it. Since a rejected
    // batch is retried unchanged, the device never recovers.
    expect(drafts).toEqual([
      {
        type: 'rename-folder',
        payload: { oldPath: 'archive', newPath: 'archive-2024' },
      },
    ]);
    detach();
  });

  it('does not let a renamed folder swallow an unrelated nested one', async () => {
    const { fire, drafts, detach } = setupListener(true);

    await fire('rename', folderNode('archive-2024'), 'archive');
    await fire('rename', folderNode('elsewhere/deep-old'), 'elsewhere/deep');

    expect(drafts).toHaveLength(2);
    expect(drafts[1]).toMatchObject({
      type: 'rename-folder',
      payload: { oldPath: 'elsewhere/deep', newPath: 'elsewhere/deep-old' },
    });
    detach();
  });
});

describe('listener: dot-directories are never synchronized', () => {
  it('ignores a folder Obsidian created under .obsidian', async () => {
    // Installing a plugin on one device must not create an empty
    // `.obsidian/plugins/<id>/` in every other vault, where two devices
    // writing the same config directory corrupt each other's settings.
    const { fire, drafts, detach } = setupListener(true);

    await fire('create', folderNode('.obsidian'));
    await fire('create', folderNode('.obsidian/plugins'));
    await fire('create', folderNode('.obsidian/plugins/thoth-sync'));
    await fire('delete', folderNode('.trash'));

    expect(drafts).toEqual([]);
    detach();
  });

  it('ignores a folder renamed into a dot-directory', async () => {
    const { fire, drafts, detach } = setupListener(true);

    await fire('rename', folderNode('.hidden'), 'archive');

    expect(drafts).toEqual([]);
    detach();
  });

  it('ignores a folder renamed out of one', async () => {
    const { fire, drafts, detach } = setupListener(true);

    await fire('rename', folderNode('archive'), '.obsidian/plugins/x');

    expect(drafts).toEqual([]);
    detach();
  });

  it('still synchronizes an ordinary folder whose name merely contains a dot', async () => {
    const { fire, drafts, detach } = setupListener(true);

    await fire('create', folderNode('v1.2/archive'));

    expect(drafts).toEqual([
      { type: 'create-folder', payload: { path: 'v1.2/archive' } },
    ]);
    detach();
  });

  it('consumes the applier record even when folders are unsupported', async () => {
    // The applier writes folders regardless of what this device will emit, so
    // its record has to be consumed either way. Left pending, it would
    // swallow the user's own create for the same path before the next sync
    // resets the guard.
    const guard = createApplyGuard();
    guard.recordPath('archive');
    const { vault, fire } = eventVault();
    const { queue, drafts } = fakeQueue();
    const detach = attachVaultListener({
      vault: vault as never,
      queue,
      getDeviceId: () => 'device-1',
      getExtensions: () => ['md'],
      canSyncFolders: () => false,
      isAppliedChange: (path) => guard.consume(path),
    });

    await fire('create', folderNode('archive'));

    expect(drafts).toEqual([]);
    expect(guard.consume('archive')).toBe(false);
    detach();
  });
});

describe('applier: applying folder operations', () => {
  function setup() {
    const vault = new MemoryVault();
    const guard = createApplyGuard();
    return { vault, guard, adapter: createObsidianVaultAdapter(vault, guard) };
  }

  it('creates the folder, and every ancestor it implies', async () => {
    const { vault, adapter } = setup();

    await applyOperationToVault(adapter, folderOp('create-folder', 'a/b/c'));

    // Obsidian refuses a folder whose parent is missing, so the ancestors
    // have to be created for the nested case to work at all.
    expect([...vault.folders].sort()).toEqual(['a', 'a/b', 'a/b/c']);
  });

  it('is a no-op when the folder already exists', async () => {
    const { vault, adapter } = setup();
    await adapter.createFolder('archive');

    await applyOperationToVault(adapter, folderOp('create-folder', 'archive'));

    expect([...vault.folders]).toEqual(['archive']);
  });

  it('deletes the folder and what was inside it', async () => {
    const { vault, adapter } = setup();
    await adapter.create('archive/a.md', 'a');
    await adapter.createFolder('archive/sub');

    await applyOperationToVault(adapter, folderOp('delete-folder', 'archive'));

    expect([...vault.folders]).toEqual([]);
    expect(vault.files.has('archive/a.md')).toBe(false);
  });

  it('is a no-op when the folder is already gone', async () => {
    const { vault, adapter } = setup();
    await adapter.create('keep.md', 'k');

    await applyOperationToVault(adapter, folderOp('delete-folder', 'missing'));

    expect(vault.files.get('keep.md')).toBe('k');
  });
});

describe('adapter: applier folder writes do not echo back as user edits', () => {
  function setup() {
    const vault = new MemoryVault();
    const guard = createApplyGuard();
    return { vault, guard, adapter: createObsidianVaultAdapter(vault, guard) };
  }

  it('records the folder and the ancestors it created', async () => {
    const { guard, adapter } = setup();

    await adapter.createFolder('a/b/c');

    // Each one is reported by Obsidian. Unrecorded, they look like folders
    // the user made and are sent back to the server as new operations.
    expect(
      ['a', 'a/b', 'a/b/c'].map((path) => guard.consume(path))
    ).toEqual([true, true, true]);
  });

  it('records every path a folder deletion removed', async () => {
    const { vault, guard, adapter } = setup();
    await adapter.create('archive/a.md', 'a');
    await adapter.create('archive/sub/b.md', 'b');
    await adapter.createFolder('archive/sub/empty');

    await adapter.deleteFolder('archive');

    // Obsidian reports a delete for the folder and for everything in it.
    // Only the paths actually removed are recorded, so a genuine edit made in
    // the same window is still queued rather than swallowed.
    expect(
      ['archive', 'archive/a.md', 'archive/sub', 'archive/sub/b.md', 'archive/sub/empty'].map(
        (path) => guard.consume(path)
      )
    ).toEqual([true, true, true, true, true]);
    expect(vault.folders.has('archive')).toBe(false);
  });

  it('records the parent folders a new note creates on the way', async () => {
    const { guard, adapter } = setup();

    await adapter.create('notes/deep/a.md', 'a');

    // Otherwise the folder creates Obsidian reports alongside the note are
    // queued as if the user had made them.
    expect(['notes', 'notes/deep'].map((p) => guard.consume(p))).toEqual([
      true,
      true,
    ]);
  });
});

describe('snapshot restore', () => {
  function setup() {
    const vault = new MemoryVault();
    const guard = createApplyGuard();
    return { vault, adapter: createObsidianVaultAdapter(vault, guard) };
  }

  it('creates the folders the snapshot carries', async () => {
    const { vault, adapter } = setup();

    await applySnapshotToVault(adapter, { 'a.md': 'hello' }, ['archive', 'notes/empty']);

    expect(vault.files.get('a.md')).toBe('hello');
    expect([...vault.folders].sort()).toEqual(['archive', 'notes', 'notes/empty']);
  });

  it('leaves a folder a local note already implies alone', async () => {
    const { vault, adapter } = setup();
    await adapter.create('notes/a.md', 'a');
    vault.calls.length = 0;

    await applySnapshotToVault(adapter, { 'notes/b.md': 'b' }, ['notes']);

    expect(vault.files.get('notes/b.md')).toBe('b');
    expect(vault.calls.filter((c) => c.startsWith('createFolder'))).toEqual([]);
  });

  it('tolerates a snapshot from a server that carries no folders', async () => {
    const { vault, adapter } = setup();

    await applySnapshotToVault(adapter, { 'a.md': 'hello' });

    expect([...vault.folders]).toEqual([]);
  });
});

describe('bootstrap: a folder that already existed locally', () => {
  const base = {
    haveAuthoritativeSnapshot: true,
    deviceId: 'dev-1',
    serverFiles: {},
    serverAssets: {},
    assetIdForPath: (path: string) => `asset:${path}`,
    localFiles: [],
  };

  it('queues a create for each local folder the server lacks', () => {
    const result = planBootstrap({
      ...base,
      serverFolders: [],
      localFolders: ['archive', 'notes/empty'],
    });

    expect(result).toEqual({
      ok: true,
      drafts: [
        { type: 'create-folder', payload: { path: 'archive' } },
        { type: 'create-folder', payload: { path: 'notes/empty' } },
      ],
    });
  });

  it('does not re-queue a folder the server already has', () => {
    // Bootstrap runs on a device's first sync only, but it must not send the
    // same folders again on a rescan either.
    const result = planBootstrap({
      ...base,
      serverFolders: ['archive'],
      localFolders: ['archive', 'notes/empty'],
    });

    expect(result).toEqual({
      ok: true,
      drafts: [{ type: 'create-folder', payload: { path: 'notes/empty' } }],
    });
  });

  it('queues nothing when the caller found no local folders to report', () => {
    // The caller passes an empty list when the server has not advertised
    // folder support, which must not surface as a failure.
    const result = planBootstrap({ ...base, serverFolders: [], localFolders: [] });

    expect(result).toEqual({ ok: true, drafts: [] });
  });
});

describe('queue', () => {
  it('stamps folder drafts like any other operation', async () => {
    const queue = new OperationQueue();

    const created = await queue.enqueue(
      { type: 'create-folder', payload: { path: 'archive' } },
      'dev-1'
    );
    const deleted = await queue.enqueue(
      { type: 'delete-folder', payload: { path: 'archive' } },
      'dev-1'
    );

    expect(created).toMatchObject({
      type: 'create-folder',
      deviceId: 'dev-1',
      revision: 0,
      payload: { path: 'archive' },
    });
    expect(deleted).toMatchObject({
      type: 'delete-folder',
      revision: 1,
      payload: { path: 'archive' },
    });
  });
});

describe('downloading a snapshot', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const stubJson = (body: unknown): void => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    ) as unknown as typeof fetch;
  };

  const base = {
    serverUrl: 'https://sync.test',
    vaultId: 'vault-1',
    apiKey: 'key-1',
  };

  it('reads the folders the server carries', async () => {
    stubJson({ revision: 3, files: { 'a.md': 'a' }, folders: ['archive'] });

    const result = await downloadSnapshot(base);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.folders).toEqual(['archive']);
  });

  it('reports no folders for a server that does not carry them', async () => {
    // Absent, not empty: a snapshot restored before the field existed is
    // still a snapshot, and the caller must not treat it as corrupt.
    stubJson({ revision: 3, files: { 'a.md': 'a' } });

    const result = await downloadSnapshot(base);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.folders).toBeUndefined();
  });

  it('ignores a malformed folders field rather than trusting it', async () => {
    stubJson({ revision: 3, files: {}, folders: 'archive' });

    const result = await downloadSnapshot(base);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.folders).toBeUndefined();
  });
});