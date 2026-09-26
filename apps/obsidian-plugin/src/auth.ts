/**
 * Credential handling for requests to the sync server.
 *
 * The server authenticates a device by a bearer token, registered when the
 * device is added to a vault. Every request that reads or changes vault data
 * must present it, so headers are built here rather than repeated at each
 * call site — a forgotten header is indistinguishable from a bug until the
 * server starts rejecting requests.
 */

/** An API key as issued by the server at registration. */
export type ApiKey = string;

function authHeader(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

/** Headers for a JSON request carrying the device credential. */
export function jsonHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...authHeader(apiKey),
  };
}

/** Headers for a request carrying a body of an explicit media type. */
export function binaryHeaders(
  apiKey: string,
  mimeType: string
): Record<string, string> {
  return { 'Content-Type': mimeType, ...authHeader(apiKey) };
}

/** Headers for a bodyless request that still needs the credential. */
export function readHeaders(apiKey: string): Record<string, string> {
  return authHeader(apiKey);
}
