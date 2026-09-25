/**
 * Thoth operations: deterministic operation engine and vault persistence.
 * Pure functions, no I/O. The server and the plugin share this package.
 */

export {
  ApplyResult,
  OperationError,
  applyOperation,
  applyOperations,
  nextRevision,
  operationError,
} from './engine.js';
export {
  AppendResult,
  OperationLog,
  appendOperation,
  createLogWindow,
  createOperationLog,
  deserializeLog,
  isCompleteLog,
  logBaseRevision,
  logContainsRevision,
  logEndRevision,
  serializeLog,
} from './log.js';
export {
  SnapshotResult,
  deserializeSnapshot,
  serializeSnapshot,
  snapshotFromLog,
} from './snapshot.js';
export { VaultState, createVaultState } from './state.js';
