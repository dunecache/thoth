/**
 * Error models shared between clients and the server.
 *
 * `error` values are machine-readable and stable; `message` is
 * human-readable. Clients must branch on `error`, never on `message`.
 */

/** Stable, machine-readable error identifiers. */
export const ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  /**
   * The credential presented was well-formed but belongs to a device that
   * is no longer registered on this vault. Distinct from `UNAUTHORIZED`
   * because the client's recovery differs: this one is always resolved by
   * re-registering the device, whereas `UNAUTHORIZED` means the credential
   * itself was absent or malformed.
   */
  'DEVICE_NOT_REGISTERED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'REVISION_MISMATCH',
  'VALIDATION_ERROR',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorResponse {
  error: ErrorCode;
  message: string;
  details?: unknown;
  requestId?: string;
}

/** Describes a single invalid field in a request. */
export interface ValidationIssue {
  /**
   * Path of the invalid field, e.g. "operations[2].type".
   * An empty path refers to the whole payload.
   */
  path: string;
  message: string;
}

export interface ValidationErrorResponse extends ErrorResponse {
  error: 'VALIDATION_ERROR';
  details: {
    issues: ValidationIssue[];
  };
}
