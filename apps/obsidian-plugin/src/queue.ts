import type {
  AddAssetPayload,
  CreateNotePayload,
  DeleteAssetPayload,
  DeleteNotePayload,
  DeleteTextPayload,
  DeviceId,
  InsertTextPayload,
  Operation,
  RenameFolderPayload,
  RenameNotePayload,
  ReplaceContentPayload,
  ReplaceRangePayload,
} from '@thoth/protocol';

/**
 * A local change before ids, devices and revisions are assigned. This is
 * the plugin-local input form the queue stamps into a full Operation.
 */
export type OperationDraft =
  | { type: 'create-note'; payload: CreateNotePayload }
  | { type: 'delete-note'; payload: DeleteNotePayload }
  | { type: 'rename-note'; payload: RenameNotePayload }
  | { type: 'replace-content'; payload: ReplaceContentPayload }
  | { type: 'insert-text'; payload: InsertTextPayload }
  | { type: 'delete-text'; payload: DeleteTextPayload }
  | { type: 'replace-range'; payload: ReplaceRangePayload }
  | { type: 'add-asset'; payload: AddAssetPayload }
  | { type: 'delete-asset'; payload: DeleteAssetPayload }
  | { type: 'rename-folder'; payload: RenameFolderPayload };

/** Called after the queue changes so callers can persist it. */
export type QueueChangeListener = (queue: OperationQueue) => Promise<void>;

/**
 * Queue of local operations waiting to be pushed.
 *
 * Local revisions mirror the engine's contiguous log: each queued
 * operation gets revision == queue position. These revisions are local
 * ordinals only; the server assigns authoritative revisions when the
 * batch is pushed (the push step re-stamps each operation).
 *
 * The queue keeps working while the network is down; persistence is
 * delegated to an optional change listener so offline edits survive
 * restarts.
 */
export class OperationQueue {
  private readonly operations: Operation[] = [];

  constructor(private readonly onChange?: QueueChangeListener) {}

  get size(): number {
    return this.operations.length;
  }

  /** Queue contents in enqueue order. */
  get all(): readonly Operation[] {
    return this.operations;
  }

  /** Next local revision (the queue position). */
  nextRevision(): number {
    return this.operations.length;
  }

  /**
   * Stamps the draft with a device, id and local revision, stores it,
   * then persists via the change listener.
   */
  async enqueue(draft: OperationDraft, deviceId: DeviceId): Promise<Operation> {
    const operation = this.build(draft, deviceId);
    this.operations.push(operation);
    if (this.onChange) {
      await this.onChange(this);
    }
    return operation;
  }

  /** Replaces the queue contents with an already-persisted list (startup). */
  replaceAll(operations: Operation[]): void {
    this.operations.length = 0;
    this.operations.push(...operations);
  }

  /** Removes the first `count` acknowledged operations from the queue. */
  dropFirst(count: number): void {
    if (count <= 0) {
      return;
    }
    this.operations.splice(0, count);
  }

  private build(draft: OperationDraft, deviceId: DeviceId): Operation {
    const id = crypto.randomUUID();
    const revision = this.nextRevision();
    switch (draft.type) {
      case 'create-note':
        return {
          id,
          type: 'create-note',
          deviceId,
          revision,
          payload: draft.payload,
        };
      case 'delete-note':
        return {
          id,
          type: 'delete-note',
          deviceId,
          revision,
          payload: draft.payload,
        };
      case 'rename-note':
        return {
          id,
          type: 'rename-note',
          deviceId,
          revision,
          payload: draft.payload,
        };
      case 'replace-content':
        return {
          id,
          type: 'replace-content',
          deviceId,
          revision,
          payload: draft.payload,
        };
      case 'insert-text':
        return {
          id,
          type: 'insert-text',
          deviceId,
          revision,
          payload: draft.payload,
        };
      case 'delete-text':
        return {
          id,
          type: 'delete-text',
          deviceId,
          revision,
          payload: draft.payload,
        };
      case 'replace-range':
        return {
          id,
          type: 'replace-range',
          deviceId,
          revision,
          payload: draft.payload,
        };
      case 'add-asset':
        return {
          id,
          type: 'add-asset',
          deviceId,
          revision,
          payload: draft.payload,
        };
      case 'delete-asset':
        return {
          id,
          type: 'delete-asset',
          deviceId,
          revision,
          payload: draft.payload,
        };
      case 'rename-folder':
        return {
          id,
          type: 'rename-folder',
          deviceId,
          revision,
          payload: draft.payload,
        };
    }
  }
}
