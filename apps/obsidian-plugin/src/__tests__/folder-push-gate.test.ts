import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A queued folder operation must not reach a server that cannot accept it.
 *
 * Emission is gated on the advertised `folders` capability, but the queue is
 * persisted across restarts while the capability is not. A folder queued
 * before a reload — or before the server was upgraded — would otherwise be
 * pushed at a server that validates operation kinds against a closed list.
 * That request fails as a whole, and because a failed batch is retried
 * unchanged, the device could never upload anything again without the user
 * clearing its queue by hand.
 *
 * Holding the batch back is the opposite of that: the change survives, the
 * cycle reports why, and it uploads as soon as a capable server answers.
 */

import { pluginStore } from '../test-support/obsidian-stub.js';
import type { Operation } from '@thoth/protocol';
import type { VaultAdapter } from '../vault-applier.js';

vi.mock('../realtime-client.js', () => ({
  connectRealtime: () => ({ close: () => {} }),
}));

const { ThothPlugin } = await import('../main.js');

type PrepareResult =
  | { ok: true; operations: Operation[] }
  | { ok: false; reason: string };

type PluginInternals = {
  serverSupportsFolders: boolean;
  prepareBatchForPush(
    batch: readonly Operation[],
    adapter: VaultAdapter
  ): Promise<PrepareResult>;
};

function createApp(): unknown {
  return {
    vault: {
      getFiles: () => [],
      getAbstractFileByPath: () => null,
      on: () => ({}),
      offref: () => {},
    },
    workspace: { layoutReady: true, onLayoutReady: () => {} },
  };
}

/** A vault that refuses every asset read, so only the folder rule can fire. */
const adapter = {
  exists: async () => false,
  read: async () => '',
} as unknown as VaultAdapter;

async function boot(): Promise<PluginInternals> {
  const plugin = new ThothPlugin(createApp() as never, {} as never);
  await (plugin as unknown as { loadPersisted(): Promise<void> }).loadPersisted();
  return plugin as unknown as PluginInternals;
}

function op(type: Operation['type'], payload: object): Operation {
  return {
    id: `op-${type}`,
    type,
    deviceId: 'device-1',
    revision: 0,
    payload,
  } as Operation;
}

const createFolder = (path: string): Operation =>
  op('create-folder', { path });
const deleteFolder = (path: string): Operation =>
  op('delete-folder', { path });
const renameFolder = (oldPath: string, newPath: string): Operation =>
  op('rename-folder', { oldPath, newPath });
const createNote = (path: string): Operation =>
  op('create-note', { path, content: 'hi' });

const PERSISTED = {
  settings: {
    serverUrl: 'https://sync.test',
    vaultId: 'vault-1',
    deviceId: 'device-1',
    apiKey: 'key-1',
    deviceName: 'Test',
    syncedExtensions: ['md'],
    lastVaultIds: [],
  },
  queue: [],
  serverRevision: 0,
};

describe('holding back folder operations the server cannot accept', () => {
  beforeEach(() => {
    pluginStore.data = structuredClone(PERSISTED);
  });

  it('holds back a queued create-folder when folders are not advertised', async () => {
    const plugin = await boot();

    const result = await plugin.prepareBatchForPush(
      [createFolder('archive')],
      adapter
    );

    expect(result).toMatchObject({ ok: false, reason: 'FOLDERS_UNSUPPORTED' });
  });

  it('holds back a queued delete-folder too', async () => {
    const plugin = await boot();

    const result = await plugin.prepareBatchForPush(
      [deleteFolder('archive')],
      adapter
    );

    expect(result).toMatchObject({ ok: false, reason: 'FOLDERS_UNSUPPORTED' });
  });

  it('holds back a queued rename-folder as well', async () => {
    const plugin = await boot();

    const result = await plugin.prepareBatchForPush(
      [renameFolder('archive', 'archive-2024')],
      adapter
    );

    expect(result).toMatchObject({ ok: false, reason: 'FOLDERS_UNSUPPORTED' });
  });

  it('holds back a batch that mixes a folder change with a note', async () => {
    const plugin = await boot();

    const result = await plugin.prepareBatchForPush(
      [createNote('notes/a.md'), createFolder('archive')],
      adapter
    );

    // Holding the whole batch, not just the folder operation: dropping one
    // would shift the queue positions the server assigns to the rest.
    expect(result).toMatchObject({ ok: false, reason: 'FOLDERS_UNSUPPORTED' });
  });

  it('sends the batch once the server has advertised folders', async () => {
    const plugin = await boot();
    plugin.serverSupportsFolders = true;

    const batch = [createFolder('archive')];
    const result = await plugin.prepareBatchForPush(batch, adapter);

    expect(result).toEqual({ ok: true, operations: batch });
  });

  it('leaves a batch with no folder operation alone', async () => {
    const plugin = await boot();

    const batch = [createNote('notes/a.md')];
    const result = await plugin.prepareBatchForPush(batch, adapter);

    expect(result).toEqual({ ok: true, operations: batch });
  });
});