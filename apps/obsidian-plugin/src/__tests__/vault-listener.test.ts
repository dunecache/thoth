import { describe, expect, it, vi } from 'vitest';

import type { EventRef, TFile, Vault } from 'obsidian';

import { createApplyGuard } from '../apply-guard.js';
import { OperationQueue } from '../queue.js';
import { attachVaultListener } from '../vault-listener.js';

class FakeVault {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>();
  readonly offref = vi.fn();
  /** Content the vault reports for a path; mutable to model edits. */
  readonly contents = new Map<string, string>();

  on(name: string, callback: (...args: unknown[]) => unknown): EventRef {
    this.handlers.set(name, callback);
    return { name, callback };
  }

  read(file: { path: string }): Promise<string> {
    return Promise.resolve(
      this.contents.get(file.path) ?? `content of ${file.path}`
    );
  }

  fire(name: string, ...args: unknown[]): void {
    const handler = this.handlers.get(name);
    if (handler) {
      handler(...args);
    }
  }
}

const note = (path: string): TFile => ({ path, extension: 'md' }) as TFile;

function setup(
  getDeviceId: () => string = () => 'dev-1',
  getExtensions: () => string[] = () => ['md']
) {
  const vault = new FakeVault();
  const queue = new OperationQueue();
  const detach = attachVaultListener({
    vault: vault as unknown as Vault,
    queue,
    getDeviceId,
    getExtensions,
  });
  return { vault, queue, detach };
}

function setupWithGuard() {
  const vault = new FakeVault();
  const queue = new OperationQueue();
  const guard = createApplyGuard();
  const detach = attachVaultListener({
    vault: vault as unknown as Vault,
    queue,
    getDeviceId: () => 'dev-1',
    getExtensions: () => ['md'],
    isAppliedChange: (path, fingerprint) => guard.consume(path, fingerprint),
  });
  return { vault, queue, guard, detach };
}

async function waitForSize(queue: OperationQueue, size: number): Promise<void> {
  await vi.waitFor(() => expect(queue.size).toBe(size));
}

describe('attachVaultListener', () => {
  it('queues a create-note operation on file create', async () => {
    const { vault, queue } = setup();
    vault.fire('create', note('notes/a.md'));

    await waitForSize(queue, 1);
    const op = queue.all[0];
    expect(op.type).toBe('create-note');
    if (op.type === 'create-note') {
      expect(op.payload).toEqual({
        path: 'notes/a.md',
        content: 'content of notes/a.md',
      });
    }
  });

  it('queues a replace-content operation on file modify', async () => {
    const { vault, queue } = setup();
    vault.fire('modify', note('notes/a.md'));

    await waitForSize(queue, 1);
    const op = queue.all[0];
    expect(op.type).toBe('replace-content');
    if (op.type === 'replace-content') {
      expect(op.payload).toEqual({
        path: 'notes/a.md',
        content: 'content of notes/a.md',
      });
    }
  });

  it('queues a rename-note operation on file rename', async () => {
    const { vault, queue } = setup();
    const file = note('notes/b.md');
    vault.fire('rename', file, 'notes/a.md');

    await waitForSize(queue, 1);
    const op = queue.all[0];
    expect(op.type).toBe('rename-note');
    if (op.type === 'rename-note') {
      expect(op.payload).toEqual({
        oldPath: 'notes/a.md',
        newPath: 'notes/b.md',
      });
    }
  });

  it('queues a delete-note operation on file delete', async () => {
    const { vault, queue } = setup();
    vault.fire('delete', note('notes/a.md'));

    await waitForSize(queue, 1);
    const op = queue.all[0];
    expect(op.type).toBe('delete-note');
    if (op.type === 'delete-note') {
      expect(op.payload).toEqual({ path: 'notes/a.md' });
    }
  });

  it('ignores files outside the configured extensions', async () => {
    const { vault, queue } = setup();
    vault.fire('create', { path: 'image.png', extension: 'png' });
    vault.fire('modify', { path: 'note.txt', extension: 'txt' });

    await vi.waitFor(() => expect(queue.size).toBe(0));
  });

  it('queues operations for configured non-markdown text files', async () => {
    const { vault, queue } = setup(() => 'dev-1', () => ['md', 'txt', 'canvas']);
    vault.fire('create', { path: 'note.txt', extension: 'txt' });

    await waitForSize(queue, 1);
    const op = queue.all[0];
    expect(op.type).toBe('create-note');
    if (op.type === 'create-note') {
      expect(op.payload.path).toBe('note.txt');
    }
  });

  it('ignores folders', async () => {
    const { vault, queue } = setup();
    vault.fire('create', { path: 'subfolder', extension: undefined });

    await vi.waitFor(() => expect(queue.size).toBe(0));
  });

  it('ignores events while no device is configured', async () => {
    const { vault, queue } = setup(() => '');
    vault.fire('create', note('notes/a.md'));

    await vi.waitFor(() => expect(queue.size).toBe(0));
  });

  it('detaches all listeners on unsubscribe', () => {
    const { vault, detach } = setup();
    detach();

    expect(vault.offref).toHaveBeenCalledTimes(4);
  });
});

describe('attachVaultListener with an apply guard', () => {
  it('drops the event caused by the applier writing a note', async () => {
    const { vault, queue, guard } = setupWithGuard();
    vault.contents.set('notes/a.md', 'from server');
    guard.recordText('notes/a.md', 'from server');

    vault.fire('modify', note('notes/a.md'));

    await vi.waitFor(() => expect(guard.pending).toBe(0));
    expect(queue.size).toBe(0);
  });

  it('keeps a local edit to another file made while the applier runs', async () => {
    const { vault, queue, guard } = setupWithGuard();
    vault.contents.set('notes/a.md', 'from server');
    guard.recordText('notes/a.md', 'from server');

    // The user edits an unrelated note mid-sync. Previously this was
    // discarded because a single "syncing" flag covered every path.
    vault.contents.set('notes/b.md', 'my own edit');
    vault.fire('modify', note('notes/b.md'));

    await waitForSize(queue, 1);
    const op = queue.all[0];
    expect(op.type).toBe('replace-content');
    if (op.type === 'replace-content') {
      expect(op.payload).toEqual({
        path: 'notes/b.md',
        content: 'my own edit',
      });
    }
  });

  it('keeps a local edit to the same file that lands after the applier write', async () => {
    const { vault, queue, guard } = setupWithGuard();
    vault.contents.set('notes/a.md', 'from server');
    guard.recordText('notes/a.md', 'from server');

    // Content moved on before the event surfaced: this is the user's edit.
    vault.contents.set('notes/a.md', 'from server, edited by me');
    vault.fire('modify', note('notes/a.md'));

    await waitForSize(queue, 1);
    const op = queue.all[0];
    expect(op.type).toBe('replace-content');
    if (op.type === 'replace-content') {
      expect(op.payload.content).toBe('from server, edited by me');
    }
  });

  it('drops the delete event caused by the applier', async () => {
    const { vault, queue, guard } = setupWithGuard();
    guard.recordPath('notes/a.md');

    vault.fire('delete', note('notes/a.md'));

    await vi.waitFor(() => expect(guard.pending).toBe(0));
    expect(queue.size).toBe(0);
  });

  it('keeps a user delete the applier did not perform', async () => {
    const { vault, queue, guard } = setupWithGuard();
    guard.recordText('notes/other.md', 'unrelated');

    vault.fire('delete', note('notes/a.md'));

    await waitForSize(queue, 1);
    expect(queue.all[0]?.type).toBe('delete-note');
  });
});
