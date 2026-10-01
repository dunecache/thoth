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
  /**
   * Set of folders renamed locally but not yet applied elsewhere. Shared with
   * the caller so the caller can clear it when a sync begins.
   */
  pendingFolderRenames?: Set<string>;
  /**
   * Whether the server accepts `rename-folder`. Absent or false means it does
   * not, and the listener falls back to per-file renames — the old behaviour,
   * which leaves the original folder behind but never sends an operation the
   * server would reject.
   */
  canRenameFolders?: () => boolean;
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

/**
 * Structural check for folders, by the same reasoning as `isSyncedFile`.
 *
 * Only used for renames. Creating or deleting an empty folder stays
 * unrepresentable until the protocol carries folder state, and emitting an
 * operation the server cannot accept would break the whole batch.
 */
function isFolderNode(file: TAbstractFile): boolean {
  return (file as TFile).extension === undefined;
}

/** True when `path` is `folder` itself or sits beneath it. */
function isWithin(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/**
 * `Vault.readBinary` is checked at runtime because older Obsidian builds
 * may not expose it, and a vault without it simply cannot sync binaries.
 */
function vaultReadBinary(vault: Vault): ((f: TFile) => Promise<ArrayBuffer>) | null {
  const candidate = (vault as Partial<Vault>).readBinary;
  if (typeof candidate !== 'function') {
    return null;
  }
  return (file: TFile) => vault.readBinary(file);
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

  /**
   * Folders renamed locally whose descendants Obsidian still has to report.
   *
   * Owned by the caller so it can lapse the set at the start of a sync, the
   * same moment the apply guard is reset. A timer would be the wrong tool:
   * the records must outlast the events they absorb, but must not outlive the
   * sync, or a genuine edit beneath that folder would be dropped.
   */
  const pendingFolderRenames = options.pendingFolderRenames ?? new Set<string>();

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
      const buffer = await readBinary(file);
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
    const content = await vault.read(file);
    if (options.isAppliedChange?.(file.path, content)) {
      return;
    }
    await register(changeToDraft({ kind, path: file.path, content }));
  };

  const handleRename = async (
    file: TAbstractFile,
    oldPath: string
  ): Promise<void> => {
    // Obsidian reports a folder rename and then one rename per descendant
    // file. Emitting those per-file renames moved the files on other devices
    // but left the original folder standing empty, because the folder itself
    // was filtered out and nothing said it should go away. One folder
    // operation carries the whole subtree instead, so the descendants that
    // follow are dropped here rather than sent.
    if (isFolderNode(file) && options.canRenameFolders?.()) {
      if (pendingFolderRenames.has(oldPath)) {
        return;
      }
      if (options.isAppliedChange?.(oldPath)) {
        return;
      }
      pendingFolderRenames.add(oldPath);
      await register(
        changeToDraft({
          kind: 'rename-folder',
          oldPath,
          newPath: file.path,
        })
      );
      return;
    }
    for (const folder of pendingFolderRenames) {
      if (isWithin(oldPath, folder)) {
        return;
      }
    }
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
