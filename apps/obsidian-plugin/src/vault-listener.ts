import type { TAbstractFile, TFile, Vault } from 'obsidian';

import { changeToDraft } from './change-detection.js';
import type { OperationDraft, OperationQueue } from './queue.js';
import {
  assetIdForPath,
  hashArrayBuffer,
  isBinaryPath,
  MAX_ASSET_SIZE,
  mimeTypeForPath,
} from './vault-applier.js';

/** Fingerprint used for binary writes, matching the guard's encoding. */
const BINARY_PREFIX = 'sha256:';

interface ListenerOptions {
  vault: Vault;
  queue: OperationQueue;
  /** Returns the configured device id; empty until the user registers. */
  getDeviceId: () => string;
  /** Returns the file extensions to synchronize as text files. */
  getExtensions: () => string[];
  /**
   * Reports whether a vault event was produced by the sync applier rather
   * than by the user. Omit to queue every event.
   */
  isAppliedChange?: (path: string, fingerprint?: string) => boolean;
  /** Called after a local change was enqueued successfully. */
  onLocalChange?: () => void;
}

/**
 * Structural check for synchronizable text files. Avoids `instanceof
 * TFile` so the listener can be tested with plain fixtures; folders have
 * no `extension` and are always excluded.
 */
function isSyncedFile(file: TAbstractFile, extensions: string[]): file is TFile {
  const ext = (file as TFile).extension;
  return typeof ext === 'string' && extensions.includes(ext.toLowerCase());
}

function vaultReadBinary(vault: Vault): ((f: TFile) => Promise<ArrayBuffer>) | null {
  const candidate = (vault as Vault & { readBinary?: (f: TFile) => Promise<ArrayBuffer> })
    .readBinary;
  return typeof candidate === 'function' ? candidate.bind(vault) : null;
}

/**
 * Watches vault file events and queues the corresponding operations.
 * Returns an unsubscribe function for use during plugin unload.
 *
 * Local processing failures (e.g. unreadable files) are logged and the
 * event is skipped rather than propagated to Obsidian's event loop.
 *
 * Events caused by the sync applier are filtered by content fingerprint in
 * `isAppliedChange`, so a genuine edit that lands while a sync is running is
 * still queued rather than discarded.
 */
export function attachVaultListener(options: ListenerOptions): () => void {
  const { vault, queue, getDeviceId, getExtensions } = options;

  const safely = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      console.error('Thoth: failed to handle vault event', error);
    }
  };

  const register = async (draft: OperationDraft): Promise<void> => {
    const deviceId = getDeviceId().trim();
    if (!deviceId) {
      // Without a registered device the operation could never be pushed.
      return;
    }
    await queue.enqueue(draft, deviceId);
    options.onLocalChange?.();
  };

  const handleUpsert = async (
    file: TAbstractFile,
    kind: 'create' | 'modify'
  ): Promise<void> => {
    if (!isSyncedFile(file, getExtensions())) {
      return;
    }
    const readBinary = vaultReadBinary(vault);
    if (isBinaryPath(file.path) && readBinary) {
      const buffer = await readBinary(file as TFile);
      if (buffer.byteLength > MAX_ASSET_SIZE) {
        console.warn('Thoth: asset too large, skipped', {
          path: file.path,
          size: buffer.byteLength,
        });
        return;
      }
      const hash = await hashArrayBuffer(buffer);
      if (options.isAppliedChange?.(file.path, `${BINARY_PREFIX}${hash}`)) {
        return;
      }
      const mimeType = mimeTypeForPath(file.path);
      await register({
        type: 'add-asset',
        payload: {
          path: file.path,
          assetId: assetIdForPath(file.path),
          hash,
          size: buffer.byteLength,
          ...(mimeType ? { mimeType } : {}),
        },
      });
      return;
    }
    const content = await vault.read(file as TFile);
    if (options.isAppliedChange?.(file.path, content)) {
      return;
    }
    await register(changeToDraft({ kind, path: file.path, content }));
  };

  const handleRename = async (
    file: TAbstractFile,
    oldPath: string
  ): Promise<void> => {
    if (!isSyncedFile(file, getExtensions())) {
      return;
    }
    if (options.isAppliedChange?.(oldPath)) {
      return;
    }
    await register(
      changeToDraft({ kind: 'rename', oldPath, newPath: file.path })
    );
  };

  const handleDelete = async (file: TAbstractFile): Promise<void> => {
    if (!isSyncedFile(file, getExtensions())) {
      return;
    }
    // The file is already gone, so no fingerprint is available.
    if (options.isAppliedChange?.(file.path)) {
      return;
    }
    if (isBinaryPath(file.path)) {
      await register({
        type: 'delete-asset',
        payload: { path: file.path, assetId: assetIdForPath(file.path) },
      });
      return;
    }
    await register(changeToDraft({ kind: 'delete', path: file.path }));
  };

  const refs = [
    vault.on('create', (file) => {
      void safely(() => handleUpsert(file, 'create'));
    }),
    vault.on('modify', (file) => {
      void safely(() => handleUpsert(file, 'modify'));
    }),
    vault.on('rename', (file, oldPath) => {
      void safely(() => handleRename(file, oldPath));
    }),
    vault.on('delete', (file) => {
      void safely(() => handleDelete(file));
    }),
  ];

  return () => {
    for (const ref of refs) {
      vault.offref(ref);
    }
  };
}
