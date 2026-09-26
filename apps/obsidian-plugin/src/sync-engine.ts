import type { Operation } from '@thoth/protocol';
import { operationSchema } from '@thoth/validation';
import { OperationQueue } from './queue.js';
import { applyOperationsToVault, type VaultAdapter } from './vault-applier.js';

function baseUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MAX_BATCH_SIZE = 100;

/** Result of an upload attempt. */
export type UploadResult =
  { ok: true; newRevision: number } | { ok: false; error: string };

/** Result of a pull attempt. */
export type PullResult =
  | { ok: true; revision: number; operations: Operation[] }
  | { ok: false; error: string; needsSnapshot?: boolean };

/**
 * Sends queued operations to the server via PushOperations.
 *
 * The caller must provide the server revision the operations are based on.
 * On success the server returns the new authoritative revision.
 */
export async function uploadOperations(params: {
  serverUrl: string;
  vaultId: string;
  baseRevision: number;
  operations: readonly Operation[];
}): Promise<UploadResult> {
  const { serverUrl, vaultId, baseRevision, operations } = params;

  if (operations.length === 0) {
    return { ok: true, newRevision: baseRevision };
  }

  if (operations.length > MAX_BATCH_SIZE) {
    return {
      ok: false,
      error: `batch size ${operations.length} exceeds ${MAX_BATCH_SIZE}`,
    };
  }

  // Re-stamp revisions so the batch is contiguous from baseRevision
  const stampedOps = operations.map((op, i) => ({
    ...op,
    revision: baseRevision + i,
  }));

  try {
    const url = `${baseUrl(serverUrl)}/vaults/${encodeURIComponent(vaultId)}/push`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseRevision,
        operations: stampedOps,
      }),
    });

    if (!res.ok) {
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        const message =
          typeof body.message === 'string' ? body.message : 'revision conflict';
        return { ok: false, error: `Conflict: ${message}` };
      }
      return { ok: false, error: `Push failed with status ${res.status}` };
    }

    const body = (await res.json().catch(() => null)) as unknown;
    if (
      typeof body === 'object' &&
      body !== null &&
      'revision' in body &&
      typeof (body as { revision: unknown }).revision === 'number'
    ) {
      return { ok: true, newRevision: (body as { revision: number }).revision };
    }

    return { ok: false, error: 'Push response missing revision' };
  } catch (error) {
    return { ok: false, error: `Push failed: ${errorMessage(error)}` };
  }
}

/**
 * Removes acknowledged operations from the queue after a successful push.
 *
 * Returns the number of operations removed.
 */
export function acknowledgeOperations(
  queue: OperationQueue,
  baseRevision: number,
  newRevision: number
): number {
  const acknowledged = newRevision - baseRevision;
  if (acknowledged <= 0) {
    return 0;
  }
  const toRemove = Math.min(acknowledged, queue.size);
  queue.dropFirst(toRemove);
  return toRemove;
}

/**
 * Downloads missing operations from the server via PullOperations.
 *
 * The server returns operations with revision >= sinceRevision.
 */
export async function downloadOperations(params: {
  serverUrl: string;
  vaultId: string;
  sinceRevision: number;
}): Promise<PullResult> {
  const { serverUrl, vaultId, sinceRevision } = params;

  try {
    const url = `${baseUrl(serverUrl)}/vaults/${encodeURIComponent(vaultId)}/pull`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sinceRevision }),
    });

    if (!res.ok) {
      if (res.status === 410) {
        return {
          ok: false,
          error:
            'server history no longer covers this revision; re-bootstrap from the snapshot',
          needsSnapshot: true,
        };
      }
      return { ok: false, error: `Pull failed with status ${res.status}` };
    }

    const body = (await res.json().catch(() => null)) as unknown;
    if (
      typeof body === 'object' &&
      body !== null &&
      'revision' in body &&
      'operations' in body &&
      typeof (body as { revision: unknown }).revision === 'number' &&
      Array.isArray((body as { operations: unknown }).operations)
    ) {
      const revision = (body as { revision: number }).revision;
      const operations = (body as { operations: unknown[] })
        .operations as Operation[];
      return { ok: true, revision, operations };
    }

    return { ok: false, error: 'Pull response missing revision or operations' };
  } catch (error) {
    return { ok: false, error: `Pull failed: ${errorMessage(error)}` };
  }
}

export async function uploadAsset(params: {
  serverUrl: string;
  vaultId: string;
  assetId: string;
  data: ArrayBuffer;
  mimeType?: string;
}): Promise<{ ok: true; hash: string } | { ok: false; error: string }> {
  if (params.data.byteLength > 10 * 1024 * 1024) {
    return { ok: false, error: `Asset too large: ${params.data.byteLength} bytes` };
  }
  try {
    const url = `${baseUrl(params.serverUrl)}/vaults/${encodeURIComponent(params.vaultId)}/assets/${encodeURIComponent(params.assetId)}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': params.mimeType ?? 'application/octet-stream',
      },
      body: params.data,
    });
    if (!res.ok) {
      return { ok: false, error: `Asset upload failed with status ${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as unknown;
    if (
      typeof body === 'object' &&
      body !== null &&
      'hash' in body &&
      typeof (body as { hash: unknown }).hash === 'string'
    ) {
      return { ok: true, hash: (body as { hash: string }).hash };
    }
    return { ok: true, hash: '' };
  } catch (error) {
    return { ok: false, error: `Asset upload failed: ${errorMessage(error)}` };
  }
}

export async function downloadAsset(params: {
  serverUrl: string;
  vaultId: string;
  assetId: string;
}): Promise<{ ok: true; data: ArrayBuffer } | { ok: false; error: string }> {
  try {
    const url = `${baseUrl(params.serverUrl)}/vaults/${encodeURIComponent(params.vaultId)}/assets/${encodeURIComponent(params.assetId)}`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      return { ok: false, error: `Asset download failed with status ${res.status}` };
    }
    const data = await res.arrayBuffer();
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: `Asset download failed: ${errorMessage(error)}` };
  }
}

/**
 * High-level download + apply. Pulls missing operations from the server
 * and applies them to the vault in order.
 *
 * Returns the new server revision on success.
 */
export type DownloadAndApplyResult =
  | { ok: true; newRevision: number }
  | { ok: false; error: string; needsSnapshot?: boolean };

export async function downloadAndApply(params: {
  serverUrl: string;
  vaultId: string;
  sinceRevision: number;
  vault: VaultAdapter;
}): Promise<DownloadAndApplyResult> {
  const pull = await downloadOperations({
    serverUrl: params.serverUrl,
    vaultId: params.vaultId,
    sinceRevision: params.sinceRevision,
  });

  if (!pull.ok) {
    return {
      ok: false,
      error: pull.error,
      ...(pull.needsSnapshot ? { needsSnapshot: true } : {}),
    };
  }

  // Validate operations from server and ignore malformed ones
  const validOps: Operation[] = [];
  for (const op of pull.operations) {
    const parsed = operationSchema(op);
    if (parsed.ok) {
      validOps.push(parsed.value);
    } else {
      console.warn('Thoth: ignoring malformed operation', {
        op,
        issues: parsed.issues,
      });
    }
  }

  if (validOps.length > 0) {
    const fetchAsset = async (assetId: string): Promise<ArrayBuffer | null> => {
      const result = await downloadAsset({
        serverUrl: params.serverUrl,
        vaultId: params.vaultId,
        assetId,
      });
      if (result.ok) {
        return result.data;
      }
      console.warn('Thoth: asset download failed', { assetId, error: result.error });
      return null;
    };
    await applyOperationsToVault(params.vault, validOps, { fetchAsset });
  }

  return { ok: true, newRevision: pull.revision };
}

export interface SnapshotAsset {
  assetId: string;
  hash: string;
  size: number;
  mimeType?: string;
}

/** Result of downloading a server snapshot. */
export type SnapshotResult =
  | { ok: true; revision: number; files: Record<string, string>; assets?: Record<string, SnapshotAsset> }
  | { ok: false; error: string };

/**
 * Downloads a vault snapshot from the server.
 */
export async function downloadSnapshot(params: {
  serverUrl: string;
  vaultId: string;
}): Promise<SnapshotResult> {
  const { serverUrl, vaultId } = params;
  try {
    const url = `${baseUrl(serverUrl)}/vaults/${encodeURIComponent(vaultId)}/snapshot`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      return {
        ok: false,
        error: `Snapshot fetch failed with status ${res.status}`,
      };
    }
    const body = (await res.json().catch(() => null)) as unknown;
    if (
      typeof body === 'object' &&
      body !== null &&
      'revision' in body &&
      'files' in body &&
      typeof (body as { revision: unknown }).revision === 'number' &&
      typeof (body as { files: unknown }).files === 'object'
    ) {
      const revision = (body as { revision: number }).revision;
      const files = (body as { files: Record<string, string> }).files;
      const assetsRaw = (body as { assets?: unknown }).assets;
      const assets =
        typeof assetsRaw === 'object' && assetsRaw !== null && !Array.isArray(assetsRaw)
          ? (assetsRaw as Record<string, SnapshotAsset>)
          : undefined;
      return { ok: true, revision, files, ...(assets ? { assets } : {}) };
    }
    return { ok: false, error: 'Snapshot response missing revision or files' };
  } catch (error) {
    return {
      ok: false,
      error: `Snapshot fetch failed: ${errorMessage(error)}`,
    };
  }
}
