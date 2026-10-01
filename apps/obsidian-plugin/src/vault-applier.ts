import {
  MAX_ASSET_BYTES,
  type Operation,
  type OperationType,
} from '@thoth/protocol';

/**
 * Minimal vault adapter required to apply operations.
 * Using a narrow interface keeps the module testable without Obsidian.
 */
export interface VaultAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  readBinary?(path: string): Promise<ArrayBuffer>;
  create(path: string, content: string): Promise<void>;
  createBinary?(path: string, data: ArrayBuffer): Promise<void>;
  modify(file: { path: string }, content: string): Promise<void>;
  modifyBinary?(file: { path: string }, data: ArrayBuffer): Promise<void>;
  rename(file: { path: string }, newPath: string): Promise<void>;
  delete(path: string): Promise<void>;
}

const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'pdf',
  'mp3',
  'mp4',
  'mov',
  'wav',
  'ogg',
  'zip',
  'tar',
  'gz',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'ico',
  'heic',
  'heif',
  'avif',
  'mkv',
  'flv',
  'webm',
  'aiff',
  'flac',
  'm4a',
  'aac',
  'psd',
  'excalidraw',
  'base',
]);

export function isBinaryPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot === -1) {
    return false;
  }
  const ext = path.slice(dot + 1).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

export function mimeTypeForPath(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return undefined;
  const ext = path.slice(dot + 1).toLowerCase();
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    zip: 'application/zip',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject',
    ico: 'image/x-icon',
    heic: 'image/heic',
    heif: 'image/heif',
    avif: 'image/avif',
    mkv: 'video/x-matroska',
    flv: 'video/x-flv',
    webm: 'video/webm',
    aiff: 'audio/aiff',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    psd: 'image/vnd.adobe.photoshop',
    excalidraw: 'application/json',
    base: 'application/octet-stream',
  };
  return map[ext];
}

export function assetIdForPath(path: string): string {
  return encodeURIComponent(path);
}

/**
 * Largest asset the server will store.
 *
 * Sourced from the shared protocol so the plugin never queues a file the
 * server is guaranteed to reject.
 */
export const MAX_ASSET_SIZE = MAX_ASSET_BYTES;

export async function hashArrayBuffer(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export interface ApplyOperationOptions {
  /** Fetches an asset blob by assetId; returns null if not found. */
  fetchAsset?: (assetId: string) => Promise<ArrayBuffer | null>;
}

/** One operation in a batch that could not be written to the vault. */
export interface ApplyFailure {
  /** Position in the batch, so the caller can log the exact operation. */
  index: number;
  type: OperationType;
  /** The path the operation targeted, when the kind carries one. */
  path: string | undefined;
  error: unknown;
}

/**
 * Raised when one or more operations in a batch could not be applied.
 *
 * The remaining operations are still attempted, so one bad path cannot block
 * unrelated work. The caller does not advance its revision when this is
 * thrown, which keeps the batch retryable rather than silently letting the
 * vault diverge from the server. Re-applying is safe: every operation is
 * either idempotent or guarded by an existence check.
 */
export class VaultApplyError extends Error {
  readonly failures: readonly ApplyFailure[];

  constructor(failures: readonly ApplyFailure[]) {
    const first = failures[0];
    const where = first?.path ?? 'unknown path';
    super(
      `Failed to apply ${failures.length} of the batched operations ` +
        `(first: ${first?.type ?? 'unknown'} at ${where}: ` +
        `${errorMessage(first?.error)})`
    );
    this.name = 'VaultApplyError';
    this.failures = failures;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** The path an operation targets, used to make failures diagnosable. */
function operationPath(operation: Operation): string | undefined {
  switch (operation.type) {
    case 'rename-note':
      return operation.payload.oldPath;
    default:
      return operation.payload.path;
  }
}

/**
 * Applies a single operation to the vault.
 *
 * The function is intentionally side-effecting but otherwise pure in its
 * mapping from operation kind to vault mutation.
 */
export async function applyOperationToVault(
  vault: VaultAdapter,
  operation: Operation,
  options?: ApplyOperationOptions
): Promise<void> {
  switch (operation.type) {
    case 'create-note': {
      const { path, content } = operation.payload;
      const exists = await vault.exists(path);
      if (isBinaryPath(path) && vault.createBinary && vault.modifyBinary) {
        const data = base64ToArrayBuffer(content);
        if (exists) {
          await vault.modifyBinary({ path }, data);
        } else {
          await vault.createBinary(path, data);
        }
      } else if (exists) {
        // If the note already exists, treat create as an upsert.
        await vault.modify({ path }, content);
      } else {
        await vault.create(path, content);
      }
      break;
    }
    case 'replace-content': {
      const { path, content } = operation.payload;
      const exists = await vault.exists(path);
      if (isBinaryPath(path) && vault.createBinary && vault.modifyBinary) {
        const data = base64ToArrayBuffer(content);
        if (!exists) {
          await vault.createBinary(path, data);
        } else {
          await vault.modifyBinary({ path }, data);
        }
      } else if (!exists) {
        // Create missing file to keep the operation log consistent.
        await vault.create(path, content);
      } else {
        await vault.modify({ path }, content);
      }
      break;
    }
    case 'rename-note': {
      const { oldPath, newPath } = operation.payload;
      const exists = await vault.exists(oldPath);
      if (exists) {
        await vault.rename({ path: oldPath }, newPath);
      }
      break;
    }
    case 'delete-note': {
      const { path } = operation.payload;
      const exists = await vault.exists(path);
      if (exists) {
        await vault.delete(path);
      }
      break;
    }
    case 'insert-text': {
      const { path, index, text } = operation.payload;
      const exists = await vault.exists(path);
      if (!exists) {
        break;
      }
      const current = await vault.read(path);
      const idx = Math.min(Math.max(index, 0), current.length);
      const next = current.slice(0, idx) + text + current.slice(idx);
      await vault.modify({ path }, next);
      break;
    }
    case 'delete-text': {
      const { path, index, length } = operation.payload;
      const exists = await vault.exists(path);
      if (!exists) {
        break;
      }
      const current = await vault.read(path);
      const idx = Math.min(Math.max(index, 0), current.length);
      const end = Math.min(idx + length, current.length);
      const next = current.slice(0, idx) + current.slice(end);
      await vault.modify({ path }, next);
      break;
    }
    case 'replace-range': {
      const { path, index, length, text } = operation.payload;
      const exists = await vault.exists(path);
      if (!exists) {
        break;
      }
      const current = await vault.read(path);
      const idx = Math.min(Math.max(index, 0), current.length);
      const end = Math.min(idx + length, current.length);
      const next = current.slice(0, idx) + text + current.slice(end);
      await vault.modify({ path }, next);
      break;
    }
    case 'add-asset': {
      const { path, assetId } = operation.payload;
      if (!options?.fetchAsset) {
        console.warn('Thoth: add-asset without fetchAsset', { path, assetId });
        break;
      }
      const data = await options.fetchAsset(assetId);
      if (!data) {
        console.warn('Thoth: asset not found', { path, assetId });
        break;
      }
      const exists = await vault.exists(path);
      if (vault.createBinary && vault.modifyBinary) {
        if (exists) {
          await vault.modifyBinary({ path }, data);
        } else {
          await vault.createBinary(path, data);
        }
      }
      break;
    }
    case 'delete-asset': {
      const { path } = operation.payload;
      const exists = await vault.exists(path);
      if (exists) {
        await vault.delete(path);
      }
      break;
    }
  }
}

/**
 * Applies a batch of operations in order.
 *
 * Every operation is attempted even if an earlier one fails, so a single bad
 * path cannot discard the rest of the batch. Failures are collected and
 * reported together in a `VaultApplyError` rather than thrown one at a time,
 * because the caller treats a throw as "revision not advanced" and must learn
 * about all of them at once.
 */
export async function applyOperationsToVault(
  vault: VaultAdapter,
  operations: readonly Operation[],
  options?: ApplyOperationOptions
): Promise<void> {
  const failures: ApplyFailure[] = [];
  let index = 0;
  for (const operation of operations) {
    try {
      await applyOperationToVault(vault, operation, options);
    } catch (error) {
      failures.push({
        index,
        type: operation.type,
        path: operationPath(operation),
        error,
      });
    }
    index += 1;
  }
  if (failures.length > 0) {
    throw new VaultApplyError(failures);
  }
}

/**
 * Restores a vault from a snapshot by writing all files.
 * Existing files are overwritten with the snapshot content.
 */
export async function applySnapshotToVault(
  vault: VaultAdapter,
  files: Record<string, string>
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const exists = await vault.exists(path);
    if (isBinaryPath(path) && vault.createBinary && vault.modifyBinary) {
      const data = base64ToArrayBuffer(content);
      if (exists) {
        await vault.modifyBinary({ path }, data);
      } else {
        await vault.createBinary(path, data);
      }
    } else if (exists) {
      await vault.modify({ path }, content);
    } else {
      await vault.create(path, content);
    }
  }
}
