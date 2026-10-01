import { describe, expect, it } from 'vitest';

import type {
  AddAssetOperation,
  CreateNoteOperation,
  DeleteNoteOperation,
  Operation,
  RenameFolderOperation,
  RenameNoteOperation,
  ReplaceContentOperation,
} from '@thoth/protocol';

import {
  applyOperation,
  applyOperations,
  nextRevision,
  operationError,
} from '../index.js';
import { createVaultState } from '../index.js';

function createNote(
  op: Partial<CreateNoteOperation> = {}
): CreateNoteOperation {
  return {
    id: 'op-create',
    type: 'create-note',
    deviceId: 'dev-1',
    revision: 0,
    payload: { path: 'notes/a.md', content: 'hello' },
    ...op,
  };
}

function deleteNote(
  op: Partial<DeleteNoteOperation> = {}
): DeleteNoteOperation {
  return {
    id: 'op-delete',
    type: 'delete-note',
    deviceId: 'dev-1',
    revision: 0,
    payload: { path: 'notes/a.md' },
    ...op,
  };
}

function renameNote(
  op: Partial<RenameNoteOperation> = {}
): RenameNoteOperation {
  return {
    id: 'op-rename',
    type: 'rename-note',
    deviceId: 'dev-1',
    revision: 0,
    payload: { oldPath: 'notes/a.md', newPath: 'notes/b.md' },
    ...op,
  };
}

function replaceContent(
  op: Partial<ReplaceContentOperation> = {}
): ReplaceContentOperation {
  return {
    id: 'op-replace',
    type: 'replace-content',
    deviceId: 'dev-1',
    revision: 0,
    payload: { path: 'notes/a.md', content: 'updated' },
    ...op,
  };
}

describe('nextRevision', () => {
  it('increments by one', () => {
    expect(nextRevision(0)).toBe(1);
    expect(nextRevision(7)).toBe(8);
  });
});

describe('operationError', () => {
  it('rejects operations with a mismatched revision', () => {
    const state = createVaultState();
    expect(operationError(createNote({ revision: 1 }), state)).toBe(
      'REVISION_MISMATCH'
    );
  });

  it('returns null for a valid create', () => {
    expect(operationError(createNote(), createVaultState())).toBeNull();
  });
});

describe('applyOperation', () => {
  it('creates a note and increments the revision', () => {
    const state = createVaultState();
    const result = applyOperation(state, createNote());
    expect(result).toEqual({
      ok: true,
      state: { revision: 1, files: { 'notes/a.md': 'hello' }, assets: {} },
    });
  });

  it('does not mutate the input state', () => {
    const state = createVaultState();
    applyOperation(state, createNote());
    expect(state).toEqual({ revision: 0, files: {}, assets: {} });
  });

  it('upserts an existing note on create', () => {
    const state = { revision: 0, files: { 'notes/a.md': 'x' }, assets: {} };
    const result = applyOperation(state, createNote());
    expect(result).toEqual({
      ok: true,
      state: { revision: 1, files: { 'notes/a.md': 'hello' }, assets: {} },
    });
  });

  it('deletes a note', () => {
    const state = { revision: 0, files: { 'notes/a.md': 'x' }, assets: {} };
    const result = applyOperation(state, deleteNote());
    expect(result).toEqual({ ok: true, state: { revision: 1, files: {}, assets: {} } });
  });

  it('rejects deleting a missing note', () => {
    const result = applyOperation(createVaultState(), deleteNote());
    expect(result).toEqual({ ok: false, error: 'NOTE_NOT_FOUND' });
  });

  it('renames a note', () => {
    const state = { revision: 0, files: { 'notes/a.md': 'content' }, assets: {} };
    const result = applyOperation(state, renameNote());
    expect(result).toEqual({
      ok: true,
      state: { revision: 1, files: { 'notes/b.md': 'content' }, assets: {} },
    });
  });

  it('rejects renaming a missing note', () => {
    const result = applyOperation(createVaultState(), renameNote());
    expect(result).toEqual({ ok: false, error: 'NOTE_NOT_FOUND' });
  });

  it('rejects renaming onto an existing note', () => {
    const state = {
      revision: 0,
      files: { 'notes/a.md': 'a', 'notes/b.md': 'b' },
      assets: {},
    };
    const result = applyOperation(state, renameNote());
    expect(result).toEqual({ ok: false, error: 'TARGET_EXISTS' });
  });

  it('replaces note content', () => {
    const state = { revision: 0, files: { 'notes/a.md': 'old' }, assets: {} };
    const result = applyOperation(state, replaceContent());
    expect(result).toEqual({
      ok: true,
      state: { revision: 1, files: { 'notes/a.md': 'updated' }, assets: {} },
    });
  });

  it('upserts a missing note on replace-content', () => {
    const result = applyOperation(createVaultState(), replaceContent());
    expect(result).toEqual({
      ok: true,
      state: { revision: 1, files: { 'notes/a.md': 'updated' }, assets: {} },
    });
  });
});

describe('applyOperations', () => {
  it('applies a batch in order', () => {
    const state = createVaultState();
    const operations: Operation[] = [
      createNote(),
      replaceContent({
        revision: 1,
        payload: { path: 'notes/a.md', content: 'edited' },
      }),
      renameNote({ revision: 2 }),
      deleteNote({ revision: 3, payload: { path: 'notes/b.md' } }),
    ];
    const result = applyOperations(state, operations);
    expect(result).toEqual({ ok: true, state: { revision: 4, files: {}, assets: {} } });
  });

  it('applies duplicate creates as upserts', () => {
    const state = createVaultState();
    const operations: Operation[] = [createNote(), createNote({ revision: 1 })];
    const result = applyOperations(state, operations);
    expect(result).toEqual({
      ok: true,
      state: { revision: 2, files: { 'notes/a.md': 'hello' }, assets: {} },
    });
  });

  it('leaves the input state untouched on failure', () => {
    const state = createVaultState();
    const operations: Operation[] = [createNote(), createNote({ revision: 1 })];
    applyOperations(state, operations);
    expect(state).toEqual({ revision: 0, files: {}, assets: {} });
  });
});

describe('rename-folder', () => {
  const renameFolder = (
    payload: RenameFolderOperation['payload'],
    revision = 1
  ): RenameFolderOperation => ({
    id: 'op-rename-folder',
    type: 'rename-folder',
    deviceId: 'dev-1',
    revision,
    payload,
  });

  const stateWith = (
    files: Record<string, string>,
    assets: Record<string, { assetId: string; hash: string; size: number }> = {}
  ) => ({ ...createVaultState(), revision: 1, files, assets });

  it('rewrites every descendant file', () => {
    const state = stateWith({
      'archive/a.md': 'a',
      'archive/deep/b.md': 'b',
      'unrelated.md': 'u',
    });

    const result = applyOperation(
      state,
      renameFolder({ oldPath: 'archive', newPath: 'archive-2024' })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.state.files).sort()).toEqual([
      'archive-2024/a.md',
      'archive-2024/deep/b.md',
      'unrelated.md',
    ]);
  });

  it('preserves file content across the move', () => {
    const result = applyOperation(
      stateWith({ 'archive/deep/b.md': 'kept' }),
      renameFolder({ oldPath: 'archive', newPath: 'new' })
    );

    expect(result.ok && result.state.files['new/deep/b.md']).toBe('kept');
  });

  it('cascades assets as well as files', () => {
    const addAsset: AddAssetOperation = {
      id: 'op-asset',
      type: 'add-asset',
      deviceId: 'dev-1',
      revision: 1,
      payload: {
        path: 'archive/img.png',
        assetId: 'img.png',
        hash: 'h',
        size: 1,
      },
    };
    const withAsset = applyOperation(
      stateWith({ 'archive/a.md': 'a' }),
      addAsset
    );
    if (!withAsset.ok) throw new Error('setup failed');

    const result = applyOperation(
      withAsset.state,
      renameFolder({ oldPath: 'archive', newPath: 'archive-2024' }, 2)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.assets['archive-2024/img.png']?.assetId).toBe('img.png');
    expect(result.state.assets['archive/img.png']).toBeUndefined();
  });

  it('does not treat a name that merely shares a prefix as a descendant', () => {
    const result = applyOperation(
      stateWith({ archive: 'file named archive', 'archive2/x.md': 'x' }),
      renameFolder({ oldPath: 'archive', newPath: 'moved' })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `archive` is a file in its own right here, and `archive2` is a
    // different folder entirely.
    expect(result.state.files['moved']).toBe('file named archive');
    expect(result.state.files['archive2/x.md']).toBe('x');
  });

  it('is a no-op rather than an error when the folder holds nothing', () => {
    // An empty folder has no trace in derived state, so refusing it would
    // wedge the batch on an ordinary user action.
    expect(
      operationError(
        renameFolder({ oldPath: 'empty', newPath: 'emptier' }),
        stateWith({ 'other.md': 'o' })
      )
    ).toBeNull();

    const result = applyOperation(
      stateWith({ 'other.md': 'o' }),
      renameFolder({ oldPath: 'empty', newPath: 'emptier' })
    );
    expect(result.ok && result.state.revision).toBe(2);
  });

  it('refuses to overwrite an occupied destination', () => {
    const state = stateWith({ 'archive/a.md': 'a', 'taken/b.md': 'b' });

    expect(
      operationError(
        renameFolder({ oldPath: 'archive', newPath: 'taken' }),
        state
      )
    ).toBe('TARGET_EXISTS');
  });

  it('leaves the input state untouched', () => {
    const state = stateWith({ 'archive/a.md': 'a' });
    const snapshot = JSON.stringify(state);

    applyOperation(state, renameFolder({ oldPath: 'archive', newPath: 'x' }));

    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('advances the revision exactly once', () => {
    const result = applyOperation(
      stateWith({ 'archive/a.md': 'a' }),
      renameFolder({ oldPath: 'archive', newPath: 'x' })
    );

    expect(result.ok && result.state.revision).toBe(2);
  });
});
