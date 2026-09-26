/**
 * Runtime schemas for the shared Thoth protocol.
 *
 * These are the single source of truth for validating request bodies as
 * they cross the wire. The server and the plugin use the same schemas so
 * client and server never drift apart.
 */

import type {
  CreateNoteOperation,
  CreateVaultRequest,
  DeleteNoteOperation,
  Operation,
  OperationType,
  PullOperationsRequest,
  PushOperationsRequest,
  RealtimeClientMessage,
  RealtimeServerMessage,
  RegisterDeviceRequest,
  RenameNoteOperation,
  ReplaceContentOperation,
} from '@thoth/protocol';

import {
  array,
  integer,
  object,
  oneOf,
  optional,
  record,
  string,
  unknownObject,
  type Validator,
} from './validators.js';

export const serverUrlSchema: Validator<string> = string({
  pattern: /^https?:\/\/.+/,
  maxLength: 500,
});

export const createVaultSchema: Validator<CreateVaultRequest> = object({
  name: optional(string({ maxLength: 200 })),
});

export const registerDeviceSchema: Validator<RegisterDeviceRequest> = object({
  deviceId: optional(
    string({
      pattern:
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    })
  ),
  name: optional(string({ maxLength: 100 })),
});

const createNotePayloadSchema: Validator<CreateNoteOperation['payload']> =
  object({
    path: string({ minLength: 1 }),
    content: string(),
  });

const deleteNotePayloadSchema: Validator<DeleteNoteOperation['payload']> =
  object({
    path: string({ minLength: 1 }),
  });

const renameNotePayloadSchema: Validator<RenameNoteOperation['payload']> =
  object({
    oldPath: string({ minLength: 1 }),
    newPath: string({ minLength: 1 }),
  });

const replaceContentPayloadSchema: Validator<
  ReplaceContentOperation['payload']
> = object({
  path: string({ minLength: 1 }),
  content: string(),
});

const insertTextPayloadSchema = object({
  path: string({ minLength: 1 }),
  index: integer({ min: 0 }),
  text: string(),
});

const deleteTextPayloadSchema = object({
  path: string({ minLength: 1 }),
  index: integer({ min: 0 }),
  length: integer({ min: 0 }),
});

const replaceRangePayloadSchema = object({
  path: string({ minLength: 1 }),
  index: integer({ min: 0 }),
  length: integer({ min: 0 }),
  text: string(),
});

const addAssetPayloadSchema = object({
  path: string({ minLength: 1 }),
  assetId: string({ minLength: 1, maxLength: 200 }),
  hash: string({ minLength: 1 }),
  size: integer({ min: 0 }),
  mimeType: optional(string({ maxLength: 200 })),
});

const deleteAssetPayloadSchema = object({
  path: string({ minLength: 1 }),
  assetId: string({ minLength: 1, maxLength: 200 }),
});

const payloadSchemas: Record<OperationType, Validator<unknown>> = {
  'create-note': createNotePayloadSchema,
  'delete-note': deleteNotePayloadSchema,
  'rename-note': renameNotePayloadSchema,
  'replace-content': replaceContentPayloadSchema,
  'insert-text': insertTextPayloadSchema,
  'delete-text': deleteTextPayloadSchema,
  'replace-range': replaceRangePayloadSchema,
  'add-asset': addAssetPayloadSchema,
  'delete-asset': deleteAssetPayloadSchema,
};

const operationBaseSchema = object({
  id: string({ minLength: 1, maxLength: 200 }),
  type: oneOf(
    'create-note',
    'delete-note',
    'rename-note',
    'replace-content',
    'insert-text',
    'delete-text',
    'replace-range',
    'add-asset',
    'delete-asset'
  ),
  deviceId: string({ minLength: 1, maxLength: 200 }),
  revision: integer({ min: 0 }),
  parentRevision: optional(integer({ min: 0 })),
  timestamp: optional(integer({ min: 0 })),
  metadata: optional(unknownObject()),
  payload: unknownObject(),
});

/**
 * Validates the operation envelope and then the type-specific payload,
 * so CreateNote, DeleteNote, RenameNote and ReplaceContent each get the
 * fields their semantics require.
 */
export const operationSchema: Validator<Operation> = (value) => {
  const base = operationBaseSchema(value);
  if (!base.ok) {
    return base;
  }

  const payloadSchema = payloadSchemas[base.value.type];
  const payload = payloadSchema(base.value.payload);
  if (!payload.ok) {
    return {
      ok: false,
      issues: payload.issues.map((issue) => ({
        path: issue.path.length === 0 ? 'payload' : `payload.${issue.path}`,
        message: issue.message,
      })),
    };
  }

  return {
    // The payload validator is keyed by the validated `type`, so the
    // runtime value is guaranteed to match the operation kind. The cast
    // is the boundary between validated (unknown) and typed data.
    ok: true,
    value: { ...base.value, payload: payload.value } as unknown as Operation,
  };
};

export const pushOperationsSchema: Validator<PushOperationsRequest> = object({
  baseRevision: integer({ min: 0 }),
  operations: array(operationSchema),
  protocolVersion: optional(integer({ min: 1 })),
  requestId: optional(string({ minLength: 1, maxLength: 200 })),
});

export const pullOperationsSchema: Validator<PullOperationsRequest> = object({
  sinceRevision: integer({ min: 0 }),
  protocolVersion: optional(integer({ min: 1 })),
  limit: optional(integer({ min: 1, max: 10000 })),
  continuationToken: optional(string({ minLength: 1, maxLength: 500 })),
});

/**
 * Schema for a persisted, append-only operation log.
 *
 * `baseRevision` is optional so logs written before the field existed still
 * validate; consumers normalize a missing value to 0, which is the correct
 * base for a log holding complete history.
 */
export const logSchema = object({
  baseRevision: optional(integer({ min: 0 })),
  operations: array(operationSchema),
});

const assetRecordSchema = object({
  assetId: string({ minLength: 1, maxLength: 200 }),
  hash: string({ minLength: 1 }),
  size: integer({ min: 0 }),
  mimeType: optional(string({ maxLength: 200 })),
});

/** Schema for a stored vault snapshot (revision + file map + optional assets). */
export const snapshotSchema = object({
  revision: integer({ min: 0 }),
  files: record(string()),
  assets: optional(record(assetRecordSchema)),
});

/** Schema for a WebSocket ticket request body. */
export const wsTicketRequestSchema: Validator<{
  deviceId: string;
  apiKey: string;
}> = object({
  deviceId: string({ minLength: 1 }),
  apiKey: string({ minLength: 1 }),
});

/** Schema for a WebSocket ticket response body. */
export const wsTicketResponseSchema: Validator<{
  ticket: string;
  expiresAt: number;
}> = object({
  ticket: string({ minLength: 1 }),
  expiresAt: integer({ min: 0 }),
});

/** Schema for server→client realtime messages. */
export const realtimeServerMessageSchema: Validator<RealtimeServerMessage> = (
  value
) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: [{ path: '', message: 'expected an object' }] };
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type === 'vault-changed') {
    const revisionResult = integer({ min: 0 })(record.revision);
    if (!revisionResult.ok) {
      return {
        ok: false,
        issues: revisionResult.issues.map((i) => ({
          path: 'revision',
          message: i.message,
        })),
      };
    }
    for (const k of Object.keys(record)) {
      if (k !== 'type' && k !== 'revision') {
        return { ok: false, issues: [{ path: k, message: 'unexpected key' }] };
      }
    }
    return { ok: true, value: { type: 'vault-changed', revision: revisionResult.value } };
  }
  if (type === 'pong') {
    for (const k of Object.keys(record)) {
      if (k !== 'type') {
        return { ok: false, issues: [{ path: k, message: 'unexpected key' }] };
      }
    }
    return { ok: true, value: { type: 'pong' } };
  }
  return {
    ok: false,
    issues: [{ path: 'type', message: 'expected vault-changed or pong' }],
  };
};

/** Schema for client→server realtime messages. */
export const realtimeClientMessageSchema: Validator<RealtimeClientMessage> = (
  value
) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: [{ path: '', message: 'expected an object' }] };
  }
  const record = value as Record<string, unknown>;
  if (record.type !== 'ping') {
    return { ok: false, issues: [{ path: 'type', message: 'expected ping' }] };
  }
  for (const k of Object.keys(record)) {
    if (k !== 'type') {
      return { ok: false, issues: [{ path: k, message: 'unexpected key' }] };
    }
  }
  return { ok: true, value: { type: 'ping' } };
};
