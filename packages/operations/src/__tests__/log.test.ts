import { describe, expect, it } from 'vitest';

import type {
  CreateNoteOperation,
  ReplaceContentOperation,
} from '@thoth/protocol';
import { ValidationError } from '@thoth/validation';

import {
  appendOperation,
  createLogWindow,
  createOperationLog,
  deserializeLog,
  isCompleteLog,
  logContainsRevision,
  logEndRevision,
  serializeLog,
} from '../index.js';

function createNote(
  op: Partial<CreateNoteOperation> = {}
): CreateNoteOperation {
  return {
    id: 'op-1',
    type: 'create-note',
    deviceId: 'dev-1',
    revision: 0,
    payload: { path: 'notes/a.md', content: 'hello' },
    ...op,
  };
}

function replaceContent(
  op: Partial<ReplaceContentOperation> = {}
): ReplaceContentOperation {
  return {
    id: 'op-2',
    type: 'replace-content',
    deviceId: 'dev-1',
    revision: 1,
    payload: { path: 'notes/a.md', content: 'edited' },
    ...op,
  };
}

describe('appendOperation', () => {
  it('starts with an empty log', () => {
    expect(createOperationLog()).toEqual({ baseRevision: 0, operations: [] });
  });

  it('appends an operation whose revision matches the log length', () => {
    const log = createOperationLog();
    const result = appendOperation(log, createNote());
    expect(result).toEqual({
      ok: true,
      log: { baseRevision: 0, operations: [createNote()] },
    });
  });

  it('keeps a contiguous revision chain', () => {
    const first = appendOperation(createOperationLog(), createNote());
    if (!first.ok) {
      throw new Error('expected append to succeed');
    }
    const second = appendOperation(first.log, replaceContent());
    expect(second.ok).toBe(true);
  });

  it('rejects an operation with a non-contiguous revision', () => {
    const log = createOperationLog();
    const result = appendOperation(log, replaceContent());
    expect(result).toEqual({ ok: false, error: 'REVISION_MISMATCH' });
  });

  it('does not mutate the input log', () => {
    const log = createOperationLog();
    appendOperation(log, createNote());
    expect(log).toEqual({ baseRevision: 0, operations: [] });
  });
});

describe('log windows', () => {
  it('appends against the window end, not the operation count', () => {
    // A compacted window holds fewer operations than the revision it has
    // reached; appending must still expect the revision after the window.
    const window = createLogWindow(300, [
      createNote({ id: 'op-300', revision: 300 }),
    ]);

    const result = appendOperation(window, createNote({ id: 'op-301', revision: 301 }));
    expect(result).toEqual({
      ok: true,
      log: {
        baseRevision: 300,
        operations: [
          createNote({ id: 'op-300', revision: 300 }),
          createNote({ id: 'op-301', revision: 301 }),
        ],
      },
    });
  });

  it('rejects an operation that revives a compacted revision', () => {
    const window = createLogWindow(300, []);
    expect(appendOperation(window, createNote({ revision: 0 }))).toEqual({
      ok: false,
      error: 'REVISION_MISMATCH',
    });
  });

  it('reports the window range', () => {
    const window = createLogWindow(300, [
      createNote({ id: 'a', revision: 300 }),
      createNote({ id: 'b', revision: 301 }),
    ]);
    expect(logEndRevision(window)).toBe(302);
    expect(logContainsRevision(window, 300)).toBe(true);
    expect(logContainsRevision(window, 301)).toBe(true);
    expect(logContainsRevision(window, 302)).toBe(false);
    expect(logContainsRevision(window, 299)).toBe(false);
  });

  it('treats only a zero-based window as complete', () => {
    expect(isCompleteLog(createOperationLog())).toBe(true);
    expect(isCompleteLog(createLogWindow(300, []))).toBe(false);
  });

  it('normalizes a legacy log with no baseRevision', () => {
    const restored = deserializeLog(
      JSON.stringify({ operations: [createNote()] })
    );
    expect(restored.baseRevision).toBe(0);
  });
});

describe('serialize/deserialize log', () => {
  it('round-trips a log through JSON', () => {
    const log = createOperationLog();
    const appended = appendOperation(log, createNote());
    if (!appended.ok) {
      throw new Error('expected append to succeed');
    }
    const restored = deserializeLog(serializeLog(appended.log));
    expect(restored).toEqual({ baseRevision: 0, operations: [createNote()] });
  });

  it('throws a SyntaxError for malformed JSON', () => {
    expect(() => deserializeLog('{not json')).toThrow(SyntaxError);
  });

  it('throws a ValidationError for invalid log shapes', () => {
    expect(() => deserializeLog('{ "operations": "nope" }')).toThrow(
      ValidationError
    );
  });

  it('throws a ValidationError for invalid operations', () => {
    const bad = JSON.stringify({
      operations: [{ id: '', type: 'create-note' }],
    });
    expect(() => deserializeLog(bad)).toThrow(ValidationError);
  });
});
