/**
 * Append-only operation log.
 *
 * A log is a contiguous window of vault history covering the revision
 * range `[baseRevision, baseRevision + operations.length)`. `baseRevision`
 * is 0 for a log that still holds the vault's complete history, and greater
 * than 0 once compaction has dropped operations that are already folded
 * into the snapshot.
 *
 * Tracking the window explicitly is what makes compaction safe: revision
 * membership can never be inferred from `operations.length`, because a
 * compacted log is shorter than the revision it has reached.
 *
 * The log is immutable; appending produces a new log and never mutates the
 * input.
 */

import type { Operation } from '@thoth/protocol';
import { logSchema } from '@thoth/validation';
import { ValidationError } from '@thoth/validation';

export interface OperationLog {
  /** Revision of `operations[0]`; 0 when the log holds all history. */
  baseRevision: number;
  operations: Operation[];
}

export type AppendResult =
  { ok: true; log: OperationLog } | { ok: false; error: 'REVISION_MISMATCH' };

export function createOperationLog(): OperationLog {
  return { baseRevision: 0, operations: [] };
}

/**
 * Builds a log window from an already-ordered slice of operations.
 *
 * `baseRevision` must be the revision of `operations[0]`. Used by
 * compaction, which retains a suffix of the history.
 */
export function createLogWindow(
  baseRevision: number,
  operations: Operation[]
): OperationLog {
  return { baseRevision, operations };
}

/** The revision the log's window starts at. */
export function logBaseRevision(log: OperationLog): number {
  return log.baseRevision;
}

/**
 * The revision one past the log's window, i.e. the oldest revision that is
 * NOT recoverable from this log alone.
 */
export function logEndRevision(log: OperationLog): number {
  return log.baseRevision + log.operations.length;
}

/**
 * True when the log still holds the vault's complete history and can
 * therefore be replayed from the empty state to rebuild a snapshot.
 */
export function isCompleteLog(log: OperationLog): boolean {
  return log.baseRevision === 0;
}

/** True when `revision` falls inside the log's window. */
export function logContainsRevision(
  log: OperationLog,
  revision: number
): boolean {
  return revision >= log.baseRevision && revision < logEndRevision(log);
}

/**
 * Appends an operation to the log. The operation's revision must equal the
 * end of the log's window so revisions stay contiguous.
 */
export function appendOperation(
  log: OperationLog,
  op: Operation
): AppendResult {
  const expectedRevision = logEndRevision(log);
  if (op.revision !== expectedRevision) {
    return { ok: false, error: 'REVISION_MISMATCH' };
  }
  return {
    ok: true,
    log: { baseRevision: log.baseRevision, operations: [...log.operations, op] },
  };
}

export function serializeLog(log: OperationLog): string {
  return JSON.stringify(log);
}

/**
 * Parses a persisted log.
 *
 * Throws a `SyntaxError` for malformed JSON and a `ValidationError` for
 * JSON that does not match LogSchema.
 */
export function deserializeLog(raw: string): OperationLog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SyntaxError('malformed operation log JSON', { cause: error });
  }
  const result = logSchema(parsed);
  if (!result.ok) {
    throw new ValidationError(result.issues);
  }
  // logSchema is structurally identical to OperationLog. A missing
  // baseRevision means the log predates the field and holds complete
  // history, so it normalizes to 0.
  return {
    baseRevision: result.value.baseRevision ?? 0,
    operations: result.value.operations,
  };
}
