import { HttpError } from './http-error.js';

/**
 * Converts a thrown value into a structured JSON error response.
 *
 * An `HttpError` is an intentional, client-facing response and its message
 * is safe to return. Anything else is an unexpected fault: only a generic
 * message is returned, so internal details — storage keys, vault ids, stack
 * traces — never reach a client. The real cause is logged with the request
 * id, which is echoed back so a report can be correlated with the logs.
 */
export function handleError(error: unknown, ctx?: { requestId?: string }) {
  if (error instanceof HttpError) {
    return new Response(
      JSON.stringify({
        error: error.code,
        message: error.message,
        details: error.details,
      }),
      {
        status: error.status,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  return new Response(
    JSON.stringify({
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: ctx?.requestId,
    }),
    {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
