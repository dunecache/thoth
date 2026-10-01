import { describe, expect, it } from 'vitest';

import {
  createVaultSchema,
  logSchema,
  operationSchema,
  pullOperationsSchema,
  pushOperationsSchema,
  realtimeClientMessageSchema,
  realtimeServerMessageSchema,
  registerDeviceSchema,
  snapshotSchema,
  wsTicketRequestSchema,
  wsTicketResponseSchema,
} from '../index.js';

const validOperation = {
  id: 'op-1',
  type: 'create-note',
  deviceId: 'device-1',
  revision: 3,
  payload: { path: 'notes/hello', content: 'hello' },
};

describe('createVaultSchema', () => {
  it('accepts an empty body', () => {
    expect(createVaultSchema({}).ok).toBe(true);
  });

  it('accepts an optional name', () => {
    expect(createVaultSchema({ name: 'docs' }).ok).toBe(true);
  });

  it('rejects a non-string name', () => {
    const result = createVaultSchema({ name: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { path: 'name', message: 'expected a string' },
      ]);
    }
  });

  it('rejects unknown keys', () => {
    const result = createVaultSchema({ owner: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { path: 'owner', message: 'unexpected key' },
      ]);
    }
  });
});

describe('registerDeviceSchema', () => {
  it('accepts an empty or named body', () => {
    expect(registerDeviceSchema({}).ok).toBe(true);
    expect(registerDeviceSchema({ name: 'Laptop' }).ok).toBe(true);
  });

  it('rejects a non-string name', () => {
    expect(registerDeviceSchema({ name: true }).ok).toBe(false);
  });
});

describe('operationSchema', () => {
  it('accepts a valid operation', () => {
    const result = operationSchema(validOperation);
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown operation type', () => {
    const result = operationSchema({ ...validOperation, type: 'explode' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        {
          path: 'type',
          message:
            'expected one of: create-note, delete-note, rename-note, replace-content, insert-text, delete-text, replace-range, add-asset, delete-asset, rename-folder',
        },
      ]);
    }
  });

  it('rejects a missing id', () => {
    const withoutId = {
      type: 'create-note',
      deviceId: 'device-1',
      revision: 3,
      payload: { path: 'notes/hello', content: 'hello' },
    };
    const result = operationSchema(withoutId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe('id');
    }
  });

  it('rejects a non-object payload', () => {
    const result = operationSchema({ ...validOperation, payload: 'text' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { path: 'payload', message: 'expected an object' },
      ]);
    }
  });

  it('requires create-note content in the payload', () => {
    const result = operationSchema({
      ...validOperation,
      payload: { path: 'notes/hello' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { path: 'payload.content', message: 'expected a string' },
      ]);
    }
  });

  it('requires rename-note newPath in the payload', () => {
    const result = operationSchema({
      ...validOperation,
      type: 'rename-note',
      payload: { oldPath: 'a.md' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { path: 'payload.newPath', message: 'expected a string' },
      ]);
    }
  });

  it('rejects pathless delete-note payloads', () => {
    const result = operationSchema({
      ...validOperation,
      type: 'delete-note',
      payload: { path: '' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { path: 'payload.path', message: 'must be at least 1 characters' },
      ]);
    }
  });
});

describe('pushOperationsSchema', () => {
  it('accepts a valid push with operations', () => {
    const request = {
      baseRevision: 2,
      operations: [validOperation],
    };
    expect(pushOperationsSchema(request).ok).toBe(true);
  });

  it('accepts an empty operation list', () => {
    expect(pushOperationsSchema({ baseRevision: 2, operations: [] }).ok).toBe(
      true
    );
  });

  it('rejects a negative base revision', () => {
    const result = pushOperationsSchema({ baseRevision: -1, operations: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { path: 'baseRevision', message: 'must be >= 0' },
      ]);
    }
  });

  it('rejects a non-array operations field', () => {
    const result = pushOperationsSchema({
      baseRevision: 2,
      operations: 'nope',
    });
    expect(result.ok).toBe(false);
  });

  it('reports issues inside operations with indexed paths', () => {
    const result = pushOperationsSchema({
      baseRevision: 2,
      operations: [{ ...validOperation, type: 'explode' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe('operations[0].type');
    }
  });
});

describe('pullOperationsSchema', () => {
  it('accepts a valid since revision', () => {
    expect(pullOperationsSchema({ sinceRevision: 5 }).ok).toBe(true);
  });

  it('rejects a negative revision', () => {
    const result = pullOperationsSchema({ sinceRevision: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { path: 'sinceRevision', message: 'must be >= 0' },
      ]);
    }
  });

  it('rejects unknown keys', () => {
    const result = pullOperationsSchema({ sinceRevision: 1, extra: true });
    expect(result.ok).toBe(false);
  });
});

describe('logSchema', () => {
  it('accepts an empty log', () => {
    expect(logSchema({ operations: [] }).ok).toBe(true);
  });

  it('accepts a log with valid operations', () => {
    expect(logSchema({ operations: [validOperation] }).ok).toBe(true);
  });

  it('rejects malformed operations inside the log', () => {
    const result = logSchema({
      operations: [{ ...validOperation, type: 'x' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe('operations[0].type');
    }
  });
});

describe('snapshotSchema', () => {
  it('accepts an empty snapshot', () => {
    expect(snapshotSchema({ revision: 0, files: {} }).ok).toBe(true);
  });

  it('accepts a snapshot with files', () => {
    expect(snapshotSchema({ revision: 2, files: { 'a.md': 'hello' } }).ok).toBe(
      true
    );
  });

  it('rejects a negative revision', () => {
    const result = snapshotSchema({ revision: -1, files: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { path: 'revision', message: 'must be >= 0' },
      ]);
    }
  });

  it('rejects non-string file contents', () => {
    const result = snapshotSchema({ revision: 0, files: { 'a.md': 42 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { path: 'files.a.md', message: 'expected a string' },
      ]);
    }
  });
});

describe('wsTicketRequestSchema', () => {
  it('accepts a valid body', () => {
    expect(wsTicketRequestSchema({ deviceId: 'd', apiKey: 'k' }).ok).toBe(true);
  });

  it('rejects empty strings', () => {
    expect(wsTicketRequestSchema({ deviceId: '', apiKey: 'k' }).ok).toBe(false);
    expect(wsTicketRequestSchema({ deviceId: 'd', apiKey: '' }).ok).toBe(false);
  });

  it('rejects unknown keys', () => {
    const result = wsTicketRequestSchema({
      deviceId: 'd',
      apiKey: 'k',
      extra: 1,
    });
    expect(result.ok).toBe(false);
  });
});

describe('wsTicketResponseSchema', () => {
  it('accepts a valid response', () => {
    expect(wsTicketResponseSchema({ ticket: 't', expiresAt: 123 }).ok).toBe(
      true
    );
  });

  it('rejects negative expiresAt', () => {
    expect(wsTicketResponseSchema({ ticket: 't', expiresAt: -1 }).ok).toBe(
      false
    );
  });
});

describe('realtimeServerMessageSchema', () => {
  it('accepts vault-changed', () => {
    expect(
      realtimeServerMessageSchema({ type: 'vault-changed', revision: 5 }).ok
    ).toBe(true);
  });

  it('accepts pong', () => {
    expect(realtimeServerMessageSchema({ type: 'pong' }).ok).toBe(true);
  });

  it('rejects unknown type', () => {
    expect(realtimeServerMessageSchema({ type: 'unknown' }).ok).toBe(false);
  });

  it('rejects negative revision', () => {
    expect(
      realtimeServerMessageSchema({ type: 'vault-changed', revision: -1 }).ok
    ).toBe(false);
  });
});

describe('realtimeClientMessageSchema', () => {
  it('accepts ping', () => {
    expect(realtimeClientMessageSchema({ type: 'ping' }).ok).toBe(true);
  });

  it('rejects non-ping types', () => {
    expect(realtimeClientMessageSchema({ type: 'pong' }).ok).toBe(false);
  });

  it('rejects extra keys', () => {
    expect(realtimeClientMessageSchema({ type: 'ping', extra: 1 }).ok).toBe(
      false
    );
  });
});
