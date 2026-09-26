/**
 * Shared primitive types used across the Thoth protocol.
 *
 * These wire-level identifiers and revisions are used by both the
 * server and the Obsidian plugin. Keep them small and opaque.
 */

export type VaultId = string;
export type DeviceId = string;
export type OperationId = string;
export type Revision = number;
export type ProtocolVersion = number;
export type AssetId = string;

export type ProtocolCapability =
  | 'batching'
  | 'partial-sync'
  | 'granular-ops'
  | 'idempotency'
  | 'version-negotiation';

/**
 * Largest asset blob the server can store, in bytes.
 *
 * A Durable Object storage entry is limited to 2 MB for key and value
 * combined, so a blob has to stay below that. The server rejects anything
 * larger with a 413 rather than letting the storage layer fail opaquely, and
 * the plugin refuses to queue a larger file in the first place — otherwise
 * a file between the two limits is uploaded on every sync and never stored.
 *
 * The headroom below the hard limit leaves room for the storage key.
 */
export const MAX_ASSET_BYTES = 1_572_864;

export interface OperationMetadata {
  [key: string]: unknown;
}
