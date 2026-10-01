/**
 * Operation models shared across the Thoth protocol.
 *
 * Every change a device makes to a vault is transmitted as an atomic
 * operation. Each operation kind carries its own payload; `Operation` is
 * the discriminated union used on the wire and by the engine.
 */

import type {
  DeviceId,
  OperationId,
  OperationMetadata,
  Revision,
} from './common.js';

export type OperationType =
  | 'create-note'
  | 'delete-note'
  | 'rename-note'
  | 'replace-content'
  | 'insert-text'
  | 'delete-text'
  | 'replace-range'
  | 'add-asset'
  | 'delete-asset'
  | 'rename-folder';

export interface CreateNotePayload {
  /** Vault-relative note path, e.g. "notes/hello". */
  path: string;
  /** Full note content. */
  content: string;
}

export interface DeleteNotePayload {
  path: string;
}

export interface RenameNotePayload {
  oldPath: string;
  newPath: string;
}

/**
 * Payload for a folder rename.
 *
 * Unlike `rename-note`, this moves a whole subtree: every file, asset and
 * nested folder beneath `oldPath` is rewritten under `newPath`. A folder
 * rename is otherwise unrepresentable, because Obsidian emits one rename
 * event per descendant file and never one for the folder's own disappearance
 * at the destination.
 */
export interface RenameFolderPayload {
  oldPath: string;
  newPath: string;
}

export interface ReplaceContentPayload {
  path: string;
  content: string;
}

export interface InsertTextPayload {
  path: string;
  /** Zero-based character offset. */
  index: number;
  text: string;
}

export interface DeleteTextPayload {
  path: string;
  /** Zero-based start offset. */
  index: number;
  /** Number of characters to delete. */
  length: number;
}

export interface ReplaceRangePayload {
  path: string;
  /** Zero-based start offset. */
  index: number;
  /** Number of characters to replace. */
  length: number;
  text: string;
}

export interface AddAssetPayload {
  path: string;
  assetId: string;
  hash: string;
  size: number;
  mimeType?: string;
}

export interface DeleteAssetPayload {
  path: string;
  assetId: string;
}

export interface CreateNoteOperation {
  id: OperationId;
  type: 'create-note';
  deviceId: DeviceId;
  /** Revision this operation applies on top of. */
  revision: Revision;
  parentRevision?: Revision;
  timestamp?: number;
  metadata?: OperationMetadata;
  payload: CreateNotePayload;
}

export interface DeleteNoteOperation {
  id: OperationId;
  type: 'delete-note';
  deviceId: DeviceId;
  revision: Revision;
  parentRevision?: Revision;
  timestamp?: number;
  metadata?: OperationMetadata;
  payload: DeleteNotePayload;
}

export interface RenameNoteOperation {
  id: OperationId;
  type: 'rename-note';
  deviceId: DeviceId;
  revision: Revision;
  parentRevision?: Revision;
  timestamp?: number;
  metadata?: OperationMetadata;
  payload: RenameNotePayload;
}

export interface RenameFolderOperation {
  id: OperationId;
  type: 'rename-folder';
  deviceId: DeviceId;
  revision: Revision;
  parentRevision?: Revision;
  timestamp?: number;
  metadata?: OperationMetadata;
  payload: RenameFolderPayload;
}

export interface ReplaceContentOperation {
  id: OperationId;
  type: 'replace-content';
  deviceId: DeviceId;
  revision: Revision;
  parentRevision?: Revision;
  timestamp?: number;
  metadata?: OperationMetadata;
  payload: ReplaceContentPayload;
}

export interface InsertTextOperation {
  id: OperationId;
  type: 'insert-text';
  deviceId: DeviceId;
  revision: Revision;
  parentRevision?: Revision;
  timestamp?: number;
  metadata?: OperationMetadata;
  payload: InsertTextPayload;
}

export interface DeleteTextOperation {
  id: OperationId;
  type: 'delete-text';
  deviceId: DeviceId;
  revision: Revision;
  parentRevision?: Revision;
  timestamp?: number;
  metadata?: OperationMetadata;
  payload: DeleteTextPayload;
}

export interface ReplaceRangeOperation {
  id: OperationId;
  type: 'replace-range';
  deviceId: DeviceId;
  revision: Revision;
  parentRevision?: Revision;
  timestamp?: number;
  metadata?: OperationMetadata;
  payload: ReplaceRangePayload;
}

export interface AddAssetOperation {
  id: OperationId;
  type: 'add-asset';
  deviceId: DeviceId;
  revision: Revision;
  parentRevision?: Revision;
  timestamp?: number;
  metadata?: OperationMetadata;
  payload: AddAssetPayload;
}

export interface DeleteAssetOperation {
  id: OperationId;
  type: 'delete-asset';
  deviceId: DeviceId;
  revision: Revision;
  parentRevision?: Revision;
  timestamp?: number;
  metadata?: OperationMetadata;
  payload: DeleteAssetPayload;
}

export type Operation =
  | CreateNoteOperation
  | DeleteNoteOperation
  | RenameNoteOperation
  | ReplaceContentOperation
  | InsertTextOperation
  | DeleteTextOperation
  | ReplaceRangeOperation
  | AddAssetOperation
  | DeleteAssetOperation
  | RenameFolderOperation;
