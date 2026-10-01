import { describe, expect, it } from 'vitest';

/**
 * A folder rename must travel as one operation.
 *
 * Obsidian reports the folder's rename and then one rename per descendant
 * file. Sending only the per-file renames moved the files on other devices
 * but left the original folder standing there empty — and any nested folder
 * with it, because nothing in the protocol ever said they should go away.
 *
 * These tests pin both halves of the fix: the listener emits a single
 * `rename-folder` and swallows the descendants, and the applier renames the
 * folder node so the old one actually disappears.
 */

import { TFile, TFolder } from 'obsidian';

import { createApplyGuard, type ApplyGuard } from '../apply-guard.js';
import { changeToDraft } from '../change-detection.js';
import { applyOperationToVault } from '../vault-applier.js';
import { createObsidianVaultAdapter } from '../vault-adapter.js';
import { attachVaultListener } from '../vault-listener.js';
import { MemoryVault } from '../test-support/memory-vault.js';
import type { Operation } from '@thoth/protocol';
import type { OperationQueue } from '../queue.js';

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

/** Minimal event emitter standing in for the parts of Obsidian's Vault used. */
function eventVault(): {
  vault: unknown;
  /** Declared as a property so callers may destructure it safely. */
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
      // Let the handler's async work settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function fakeQueue(): { queue: OperationQueue; drafts: Operation[] } {
  const drafts: Operation[] = [];
  const queue = {
    enqueue: async (draft: { type: string; payload: unknown }) => {
      drafts.push(draft as unknown as Operation);
      return draft as unknown as Operation;
    },
    size: drafts.length,
  } as unknown as OperationQueue;
  return { queue, drafts };
}

describe('changeToDraft for a folder rename', () => {
  it('produces a single rename-folder draft', () => {
    const draft = changeToDraft({
      kind: 'rename-folder',
      oldPath: 'archive',
      newPath: 'archive-2024',
    });

    expect(draft).toEqual({
      type: 'rename-folder',
      payload: { oldPath: 'archive', newPath: 'archive-2024' },
    });
  });
});

describe('listener: folder rename emits one operation, not N', () => {
  function setup(canRenameFolders: boolean) {
    const { vault, fire } = eventVault();
    const { queue, drafts } = fakeQueue();
    const pendingFolderRenames = new Set<string>();
    const detach = attachVaultListener({
      vault: vault as never,
      queue,
      getDeviceId: () => 'device-1',
      getExtensions: () => ['md'],
      pendingFolderRenames,
      canRenameFolders: () => canRenameFolders,
    });
    return { fire, drafts, pendingFolderRenames, detach };
  }

  it('emits one rename-folder and drops the descendant renames', async () => {
    const { fire, drafts, detach } = setup(true);

    await fire('rename', folderNode('archive-2024'), 'archive');
    await fire('rename', fileNode('archive-2024/a.md'), 'archive/a.md');
    await fire('rename', fileNode('archive-2024/deep/b.md'), 'archive/deep/b.md');

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      type: 'rename-folder',
      payload: { oldPath: 'archive', newPath: 'archive-2024' },
    });
    detach();
  });

  it('still emits per-file renames for folders the server cannot accept', async () => {
    const { fire, drafts, detach } = setup(false);

    await fire('rename', folderNode('archive-2024'), 'archive');
    await fire('rename', fileNode('archive-2024/a.md'), 'archive/a.md');

    // The folder itself is still filtered out, so an old server sees only
    // file renames — the old behaviour, which never wedges the batch.
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ type: 'rename-note' });
    detach();
  });

  it('does not let one folder rename suppress a later rename elsewhere', async () => {
    const { fire, drafts, pendingFolderRenames, detach } = setup(true);

    await fire('rename', folderNode('archive-2024'), 'archive');
    pendingFolderRenames.clear();
    await fire('rename', fileNode('other/y.md'), 'other/x.md');

    expect(drafts).toHaveLength(2);
    expect(drafts[1]).toMatchObject({
      type: 'rename-note',
      payload: { oldPath: 'other/x.md', newPath: 'other/y.md' },
    });
    detach();
  });

  it('does not suppress a sibling folder whose name shares the prefix', async () => {
    const { fire, drafts, detach } = setup(true);

    await fire('rename', folderNode('archive-2024'), 'archive');
    await fire('rename', fileNode('archive2/y.md'), 'archive2/x.md');

    expect(drafts).toHaveLength(2);
    detach();
  });
});

describe('applier: applying rename-folder removes the old folder', () => {
  function setup() {
    const vault = new MemoryVault();
    const guard: ApplyGuard = createApplyGuard();
    const adapter = createObsidianVaultAdapter(vault, guard);
    return { vault, guard, adapter };
  }

  const op = (payload: Record<string, unknown>): Operation =>
    ({
      id: 'rf-1',
      type: 'rename-folder',
      deviceId: 'd1',
      revision: 1,
      parentRevision: 0,
      payload,
    }) as unknown as Operation;

  it('moves the subtree and leaves no stale folder behind', async () => {
    const { vault, adapter } = setup();
    await adapter.create('archive/a.md', 'a');
    await adapter.create('archive/deep/b.md', 'b');

    await applyOperationToVault(adapter, op({
      oldPath: 'archive',
      newPath: 'archive-2024',
    }));

    expect(vault.files.get('archive-2024/a.md')).toBe('a');
    expect(vault.files.get('archive-2024/deep/b.md')).toBe('b');
    // The reported symptom: both the old folder and its nested folder stayed.
    expect(vault.folders.has('archive')).toBe(false);
    expect(vault.folders.has('archive/deep')).toBe(false);
    expect(vault.folders.has('archive-2024/deep')).toBe(true);
  });

  it('is a no-op when the folder is already gone', async () => {
    const { vault, adapter } = setup();
    await adapter.create('keep.md', 'k');

    await applyOperationToVault(adapter, op({
      oldPath: 'missing',
      newPath: 'other',
    }));

    expect([...vault.folders]).toEqual([]);
    expect(vault.files.get('keep.md')).toBe('k');
  });

  it('records every moved path so the vault events do not echo back', async () => {
    const { vault, guard, adapter: seedAdapter } = setup();
    await seedAdapter.create('archive/a.md', 'a');
    await seedAdapter.create('archive/deep/b.md', 'b');
    // Record which paths Obsidian's events would be judged against, exactly as
    // the vault listener judges them.
    const tracking: ApplyGuard = {
      recordText: (path, content) => guard.recordText(path, content),
      recordBinary: (path, hash) => guard.recordBinary(path, hash),
      recordPath: (path) => guard.recordPath(path),
      recordFolderRename: (oldPath, newPath, descendants) =>
        guard.recordFolderRename(oldPath, newPath, descendants),
      consume: (path, fingerprint) => guard.consume(path, fingerprint),
      reset: () => guard.reset(),
      get pending() {
        return guard.pending;
      },
    };
    const adapter = createObsidianVaultAdapter(vault, tracking);

    await applyOperationToVault(adapter, op({
      oldPath: 'archive',
      newPath: 'archive-2024',
    }));

    // Obsidian now delivers a rename event for the folder and for each
    // descendant. The listener judges each through this same guard, so each
    // must be recognised as self-inflicted — otherwise it is queued and sent
    // back to a server that has already moved those paths, which rejects the
    // whole batch.
    const verdicts = [
      'archive',
      'archive-2024',
      'archive/a.md',
      'archive/deep/b.md',
    ].map((path) => tracking.consume(path));

    expect(verdicts).toEqual([true, true, true, true]);
    expect(vault.files.has('archive/a.md')).toBe(false);
  });
});