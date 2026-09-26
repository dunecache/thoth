/**
 * Operation engine: applies atomic operations to a vault state.
 *
 * The engine is pure and deterministic. Every function returns a
 * discriminated result instead of throwing; invalid operations are
 * rejected with a stable, machine-readable error identifier.
 */

import type { Operation } from '@thoth/protocol';

import type { VaultState } from './state.js';

export type OperationError =
  'NOTE_EXISTS' | 'NOTE_NOT_FOUND' | 'TARGET_EXISTS' | 'REVISION_MISMATCH';

export type ApplyResult =
  { ok: true; state: VaultState } | { ok: false; error: OperationError };

/** The next revision after applying one operation. */
export function nextRevision(revision: number): number {
  return revision + 1;
}

/**
 * Checks an operation against the current state without applying it.
 * Returns `null` when the operation is valid.
 */
export function operationError(
  op: Operation,
  state: VaultState
): OperationError | null {
  // An operation applies on top of exactly the current revision.
  if (op.revision !== state.revision) {
    return 'REVISION_MISMATCH';
  }

  switch (op.type) {
    case 'create-note':
      // Upsert semantics: create-note is idempotent and overwrites existing notes
      // This aligns with the client vault-applier and allows clean first-sync imports
      return null;
    case 'delete-note':
      return op.payload.path in state.files ? null : 'NOTE_NOT_FOUND';
    case 'rename-note': {
      const inFiles = op.payload.oldPath in state.files;
      const inAssets = op.payload.oldPath in state.assets;
      if (!inFiles && !inAssets) {
        return 'NOTE_NOT_FOUND';
      }
      const targetInFiles = op.payload.newPath in state.files;
      const targetInAssets = op.payload.newPath in state.assets;
      return targetInFiles || targetInAssets ? 'TARGET_EXISTS' : null;
    }
    case 'replace-content':
      return null;
    case 'insert-text':
    case 'delete-text':
    case 'replace-range':
      return op.payload.path in state.files ? null : 'NOTE_NOT_FOUND';
    case 'add-asset':
      return null;
    case 'delete-asset':
      return op.payload.path in state.assets ? null : 'NOTE_NOT_FOUND';
  }
}

/**
 * Applies a single operation, returning a new state on success.
 * The input state is never mutated.
 */
export function applyOperation(state: VaultState, op: Operation): ApplyResult {
  const error = operationError(op, state);
  if (error) {
    return { ok: false, error };
  }

  const files = { ...state.files };
  const assets = { ...state.assets };
  switch (op.type) {
    case 'create-note':
      files[op.payload.path] = op.payload.content;
      break;
    case 'delete-note':
      delete files[op.payload.path];
      break;
    case 'rename-note': {
      if (op.payload.oldPath in files) {
        const content = files[op.payload.oldPath];
        delete files[op.payload.oldPath];
        files[op.payload.newPath] = content;
      }
      if (op.payload.oldPath in assets) {
        const meta = assets[op.payload.oldPath];
        delete assets[op.payload.oldPath];
        assets[op.payload.newPath] = meta;
      }
      break;
    }
    case 'replace-content':
      files[op.payload.path] = op.payload.content;
      break;
    case 'insert-text': {
      const existing = files[op.payload.path] ?? '';
      const idx = Math.min(Math.max(op.payload.index, 0), existing.length);
      files[op.payload.path] =
        existing.slice(0, idx) + op.payload.text + existing.slice(idx);
      break;
    }
    case 'delete-text': {
      const existing = files[op.payload.path] ?? '';
      const idx = Math.min(Math.max(op.payload.index, 0), existing.length);
      const end = Math.min(idx + op.payload.length, existing.length);
      files[op.payload.path] = existing.slice(0, idx) + existing.slice(end);
      break;
    }
    case 'replace-range': {
      const existing = files[op.payload.path] ?? '';
      const idx = Math.min(Math.max(op.payload.index, 0), existing.length);
      const end = Math.min(idx + op.payload.length, existing.length);
      files[op.payload.path] =
        existing.slice(0, idx) + op.payload.text + existing.slice(end);
      break;
    }
    case 'add-asset': {
      const { path, assetId, hash, size, mimeType } = op.payload;
      assets[path] = { assetId, hash, size, ...(mimeType ? { mimeType } : {}) };
      break;
    }
    case 'delete-asset': {
      delete assets[op.payload.path];
      break;
    }
  }

  return { ok: true, state: { revision: nextRevision(state.revision), files, assets } };
}

/**
 * Applies operations in order and stops at the first rejected one.
 * Earlier operations are applied to an independent state copy, so a
 * rejected batch leaves the input state untouched.
 */
export function applyOperations(
  state: VaultState,
  operations: Operation[]
): ApplyResult {
  let current = state;
  for (const op of operations) {
    const result = applyOperation(current, op);
    if (!result.ok) {
      return result;
    }
    current = result.state;
  }
  return { ok: true, state: current };
}
