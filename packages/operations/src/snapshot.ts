/**
 * Vault snapshots.
 *
 * A snapshot captures the full state (revision + file map) reachable
 * from an operation log. Snapshots let the server restore a vault
 * without replaying every operation.
 */

import type { OperationError } from './engine.js';
import { applyOperations } from './engine.js';
import { isCompleteLog, type OperationLog } from './log.js';
import { createVaultState, type VaultState } from './state.js';
import { ValidationError, snapshotSchema } from '@thoth/validation';

export type SnapshotResult =
  | { ok: true; state: VaultState }
  | { ok: false; error: OperationError | 'INCOMPLETE_LOG' };

/**
 * Replays a log against the empty state. Returns a rejected result if
 * the log contains an invalid operation or a revision gap.
 *
 * Only a complete log (`baseRevision === 0`) can be replayed this way: a
 * compacted window starts at a non-zero revision, and replaying it from the
 * empty state would silently discard every operation before the window.
 * Callers must check `isCompleteLog` and treat a windowed log as
 * unrecoverable rather than rebuilding from it.
 */
export function snapshotFromLog(log: OperationLog): SnapshotResult {
  if (!isCompleteLog(log)) {
    return { ok: false, error: 'INCOMPLETE_LOG' };
  }
  return applyOperations(createVaultState(), log.operations);
}

export function serializeSnapshot(state: VaultState): string {
  return JSON.stringify(state);
}

/**
 * Parses a persisted snapshot.
 *
 * Throws a `SyntaxError` for malformed JSON and a `ValidationError` for
 * JSON that does not match SnapshotSchema.
 */
export function deserializeSnapshot(raw: string): VaultState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SyntaxError('malformed snapshot JSON', { cause: error });
  }
  const result = snapshotSchema(parsed);
  if (!result.ok) {
    throw new ValidationError(result.issues);
  }
  // Normalize missing assets for backward compat
  const value = result.value as VaultState;
  if (!value.assets) {
    value.assets = {};
  }
  return value;
}
