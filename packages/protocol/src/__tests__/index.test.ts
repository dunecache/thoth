import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  AddAssetOperation,
  CreateNoteOperation,
  CreateNotePayload,
  DeleteAssetOperation,
  DeleteNoteOperation,
  DeleteTextOperation,
  ERROR_CODES,
  ErrorResponse,
  InsertTextOperation,
  Operation,
  PullOperationsResponse,
  PushOperationsRequest,
  RegisterDeviceResponse,
  RenameNoteOperation,
  ReplaceContentOperation,
  ReplaceRangeOperation,
  ValidationErrorResponse,
} from '../index.js';

describe('protocol', () => {
  it('exposes stable error identifiers', () => {
    expect(ERROR_CODES).toContain('BAD_REQUEST');
    expect(ERROR_CODES).toContain('UNAUTHORIZED');
    expect(ERROR_CODES).toContain('DEVICE_NOT_REGISTERED');
    expect(ERROR_CODES).toContain('FORBIDDEN');
    expect(ERROR_CODES).toContain('NOT_FOUND');
    expect(ERROR_CODES).toContain('CONFLICT');
    expect(ERROR_CODES).toContain('REVISION_MISMATCH');
    expect(ERROR_CODES).toContain('VALIDATION_ERROR');
    expect(ERROR_CODES).toContain('INTERNAL_ERROR');
  });

  it('operation type is a closed union of supported kinds', () => {
    expectTypeOf<Operation['type']>().toEqualTypeOf<
      | 'create-note'
      | 'delete-note'
      | 'rename-note'
      | 'replace-content'
      | 'insert-text'
      | 'delete-text'
      | 'replace-range'
      | 'add-asset'
      | 'delete-asset'
    >();
  });

  it('narrows payloads to the operation kind', () => {
    expectTypeOf<
      CreateNoteOperation['payload']
    >().toEqualTypeOf<CreateNotePayload>();
    expectTypeOf<DeleteNoteOperation['type']>().toEqualTypeOf<'delete-note'>();
    expectTypeOf<Operation['payload']>().toEqualTypeOf<
      | CreateNoteOperation['payload']
      | DeleteNoteOperation['payload']
      | RenameNoteOperation['payload']
      | ReplaceContentOperation['payload']
      | InsertTextOperation['payload']
      | DeleteTextOperation['payload']
      | ReplaceRangeOperation['payload']
      | AddAssetOperation['payload']
      | DeleteAssetOperation['payload']
    >();
  });

  it('push request carries a base revision and ordered operations', () => {
    expectTypeOf<
      PushOperationsRequest['baseRevision']
    >().toEqualTypeOf<number>();
    expectTypeOf<PushOperationsRequest['operations']>().toEqualTypeOf<
      Operation[]
    >();
  });

  it('pull response returns a revision and operations', () => {
    expectTypeOf<PullOperationsResponse['operations']>().toEqualTypeOf<
      Operation[]
    >();
    expectTypeOf<PullOperationsResponse['revision']>().toEqualTypeOf<number>();
  });

  it('register device response returns an api key', () => {
    expectTypeOf<RegisterDeviceResponse['apiKey']>().toEqualTypeOf<string>();
  });

  it('validation errors pin the error code to VALIDATION_ERROR', () => {
    expectTypeOf<
      ValidationErrorResponse['error']
    >().toEqualTypeOf<'VALIDATION_ERROR'>();
    expectTypeOf<ValidationErrorResponse['details']['issues']>().toEqualTypeOf<
      Array<{ path: string; message: string }>
    >();
  });

  it('generic error responses carry a stable error code and message', () => {
    expectTypeOf<ErrorResponse['error']>().toEqualTypeOf<
      (typeof ERROR_CODES)[number]
    >();
    expectTypeOf<ErrorResponse['message']>().toEqualTypeOf<string>();
  });
});
