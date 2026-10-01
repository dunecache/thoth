import { beforeEach, describe, expect, it } from 'vitest';

import { TFile } from 'obsidian';

import { createApplyGuard } from '../apply-guard.js';
import type { ApplyGuard } from '../apply-guard.js';
import { applyOperationsToVault, VaultApplyError } from '../vault-applier.js';
import {
  createObsidianVaultAdapter,
  VaultPathConflictError,
} from '../vault-adapter.js';
import { MemoryVault } from '../test-support/memory-vault.js';
import type { Operation } from '@thoth/protocol';

function setup(): {
  vault: MemoryVault;
  guard: ApplyGuard;
  adapter: ReturnType<typeof createObsidianVaultAdapter>;
} {
  const vault = new MemoryVault();
  const guard = createApplyGuard();
  return { vault, guard, adapter: createObsidianVaultAdapter(vault, guard) };
}

/** Operation builder that fills in the fields the applier never reads. */
function op(
  type: Operation['type'],
  payload: Record<string, unknown>,
  revision = 1
): Operation {
  return {
    id: `${type}-${revision}`,
    type,
    payload,
    deviceId: 'device-1',
    revision,
    parentRevision: revision - 1,
  } as unknown as Operation;
}

describe('ensureFolders on create', () => {
  it('creates every missing ancestor of a nested path', async () => {
    const { vault, adapter } = setup();
    await adapter.create('a/b/c/note.md', 'hi');

    expect(vault.folders.has('a')).toBe(true);
    expect(vault.folders.has('a/b')).toBe(true);
    expect(vault.folders.has('a/b/c')).toBe(true);
    expect(vault.files.get('a/b/c/note.md')).toBe('hi');
  });

  it('creates nothing for a root-level file', async () => {
    const { vault, adapter } = setup();
    await adapter.create('note.md', 'hi');

    expect([...vault.folders]).toEqual([]);
    expect(vault.calls).toEqual(['create:note.md']);
  });

  it('reuses folders that already exist', async () => {
    const { vault, adapter } = setup();
    await adapter.create('a/one.md', '1');

    await adapter.create('a/two.md', '2');

    expect(vault.calls).toEqual([
      'createFolder:a',
      'create:a/one.md',
      'create:a/two.md',
    ]);
  });

  it('rejects a path whose ancestor is an existing file', async () => {
    const { adapter } = setup();
    await adapter.create('blocker.md', 'x');

    await expect(adapter.create('blocker.md/child.md', 'y')).rejects.toThrow(
      VaultPathConflictError
    );
  });

  it('creates parents for binary creates too', async () => {
    const { vault, adapter } = setup();
    if (!adapter.createBinary) throw new Error('adapter lacks createBinary');
    await adapter.createBinary('img/deep/pic.png', new ArrayBuffer(4));

    expect(vault.folders.has('img/deep')).toBe(true);
    expect(vault.binaries.has('img/deep/pic.png')).toBe(true);
  });
});

describe('ensureFolders on rename', () => {
  it('creates the destination folder when moving a note into a new folder', async () => {
    const { vault, adapter } = setup();
    await adapter.create('note.md', 'hi');

    // The regression: without ensureFolders the destination folder is absent
    // and Obsidian's rename rejects the move.
    await adapter.rename({ path: 'note.md' }, 'archive/note.md');

    expect(vault.folders.has('archive')).toBe(true);
    expect(vault.files.has('archive/note.md')).toBe(true);
    expect(vault.files.has('note.md')).toBe(false);
  });

  it('creates every missing ancestor of a deep destination', async () => {
    const { vault, adapter } = setup();
    await adapter.create('note.md', 'hi');

    await adapter.rename({ path: 'note.md' }, 'x/y/z/note.md');

    expect(vault.folders.has('x')).toBe(true);
    expect(vault.folders.has('x/y')).toBe(true);
    expect(vault.folders.has('x/y/z')).toBe(true);
    expect(vault.files.has('x/y/z/note.md')).toBe(true);
  });

  it('moves every file of a folder when the folder itself is renamed', async () => {
    const { vault, adapter } = setup();
    await adapter.create('archive/a.md', 'a');
    await adapter.create('archive/deep/b.md', 'b');

    await adapter.rename({ path: 'archive' }, 'archive-2024');

    expect(vault.folders.has('archive-2024/deep')).toBe(true);
    expect(vault.files.get('archive-2024/a.md')).toBe('a');
    expect(vault.files.get('archive-2024/deep/b.md')).toBe('b');
    expect(vault.folders.has('archive')).toBe(false);
  });

  it('leaves no stray folder when renaming something already gone', async () => {
    const { vault, adapter } = setup();

    await adapter.rename({ path: 'missing.md' }, 'new/missing.md');

    expect([...vault.folders]).toEqual([]);
    expect(vault.calls).toEqual([]);
  });

  it('moves a binary asset into a new folder', async () => {
    const { vault, adapter } = setup();
    if (!adapter.createBinary) throw new Error('adapter lacks createBinary');
    const data = new ArrayBuffer(8);
    await adapter.createBinary('pic.png', data);

    await adapter.rename({ path: 'pic.png' }, 'img/pic.png');

    expect(vault.folders.has('img')).toBe(true);
    expect(vault.binaries.has('img/pic.png')).toBe(true);
  });

  it('records both paths with the apply guard', async () => {
    const { vault, guard, adapter } = setup();
    await adapter.create('note.md', 'hi');

    await adapter.rename({ path: 'note.md' }, 'archive/note.md');

    // Both events must be suppressed on the way back through the listener.
    expect(guard.consume('note.md', '')).toBe(true);
    expect(guard.consume('archive/note.md', '')).toBe(true);
    expect(vault.files.has('archive/note.md')).toBe(true);
  });
});

describe('exists and read narrowing', () => {
  it('reports a folder as existing but not readable as a file', async () => {
    const { adapter } = setup();
    await adapter.create('dir/a.md', 'hi');

    expect(await adapter.exists('dir')).toBe(true);
    await expect(adapter.read('dir')).rejects.toThrow(/File not found/);
  });

  it('treats modify of a folder as a no-op', async () => {
    const { vault, adapter } = setup();
    await adapter.create('dir/a.md', 'hi');

    await adapter.modify({ path: 'dir' }, 'clobbered');

    expect(vault.files.get('dir/a.md')).toBe('hi');
  });
});

describe('applyOperationsToVault error isolation', () => {
  let vault: MemoryVault;
  let adapter: ReturnType<typeof createObsidianVaultAdapter>;

  beforeEach(() => {
    const s = setup();
    vault = s.vault;
    adapter = s.adapter;
    vault.failOn = undefined;
  });

  it('still applies operations that come after a failing one', async () => {
    vault.failOn = (label, path) => label === 'create' && path === 'a.md';

    const error = await applyOperationsToVault(adapter, [
      op('create-note', { path: 'a.md', content: 'a' }),
      op('create-note', { path: 'b.md', content: 'b' }),
    ]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VaultApplyError);
    expect((error as VaultApplyError).failures).toHaveLength(1);
    expect(vault.files.get('b.md')).toBe('b');
  });

  it('reports every failure and does not hide them behind the first', async () => {
    vault.failOn = (label, path) => label === 'create' && path.startsWith('bad-');

    const error = await applyOperationsToVault(adapter, [
      op('create-note', { path: 'bad-1.md', content: 'x' }),
      op('create-note', { path: 'good.md', content: 'y' }),
      op('create-note', { path: 'bad-2.md', content: 'z' }),
    ]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VaultApplyError);
    const failures = (error as VaultApplyError).failures;
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ index: 0, type: 'create-note', path: 'bad-1.md' });
    expect(failures[1]).toMatchObject({ index: 2, path: 'bad-2.md' });
    // The healthy operation between them was still applied.
    expect(vault.files.get('good.md')).toBe('y');
  });

  it('surfaces the failing path and count in the message', async () => {
    vault.failOn = (label) => label === 'create';

    const error = (await applyOperationsToVault(adapter, [
      op('create-note', { path: 'broken.md', content: 'x' }),
    ]).catch((e: unknown) => e)) as VaultApplyError;

    expect(error.message).toContain('broken.md');
    expect(error.message).toContain('create-note');
    expect(error.message).toContain('1 of');
  });

  it('reports the source path of a failing rename', async () => {
    await adapter.create('note.md', 'hi');
    vault.failOn = (label) => label === 'rename';

    const error = (await applyOperationsToVault(adapter, [
      op('rename-note', { oldPath: 'note.md', newPath: 'archive/note.md' }),
    ]).catch((e: unknown) => e)) as VaultApplyError;

    expect(error.failures[0]?.path).toBe('note.md');
  });

  it('applies a batch cleanly when nothing fails', async () => {
    await expect(
      applyOperationsToVault(adapter, [
        op('create-note', { path: 'a.md', content: 'a' }),
        op('create-note', { path: 'nested/b.md', content: 'b' }),
      ])
    ).resolves.toBeUndefined();

    expect(vault.folders.has('nested')).toBe(true);
    expect(vault.files.get('nested/b.md')).toBe('b');
  });

  it('moves a note between folders through a full operation batch', async () => {
    await adapter.create('notes/a.md', 'hello');

    await applyOperationsToVault(adapter, [
      op('rename-note', { oldPath: 'notes/a.md', newPath: 'archive/a.md' }),
    ]);

    expect(vault.folders.has('archive')).toBe(true);
    expect(vault.files.get('archive/a.md')).toBe('hello');
  });
});

describe('fileAt narrowing against real TFile instances', () => {
  it('reads a file the vault resolves', async () => {
    const { vault, adapter } = setup();
    await adapter.create('a.md', 'content');

    const resolved = vault.getAbstractFileByPath('a.md');
    expect(resolved).toBeInstanceOf(TFile);

    expect(await adapter.read('a.md')).toBe('content');
  });
});