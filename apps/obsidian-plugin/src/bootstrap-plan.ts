/**
 * First-sync reconciliation.
 *
 * When a device syncs for the first time it has never compared its local
 * vault against the server's, so it has to decide which side wins for every
 * file. That decision is the dangerous one: getting it wrong overwrites a
 * shared vault with a single device's contents, destroying every other
 * device's notes.
 *
 * The rule is therefore conservative. Local content may only be uploaded
 * when the server's state was actually read. A missing or failed snapshot
 * means "unknown", not "empty", and yields no uploads at all.
 */

import type { SnapshotAsset } from './sync-engine.js';
import type { OperationDraft } from './queue.js';

/** A local file that has already been read from the vault. */
export type LocalEntry =
  | { kind: 'text'; path: string; content: string }
  | {
      kind: 'binary';
      path: string;
      hash: string;
      size: number;
      mimeType?: string;
    }
  | { kind: 'skipped'; path: string; reason: string };

export type BootstrapPlan =
  | { ok: false; reason: 'NO_DEVICE' | 'NO_AUTHORITATIVE_SNAPSHOT' }
  | { ok: true; drafts: OperationDraft[] };

export function planBootstrap(params: {
  /** True only when a snapshot fetch actually succeeded. */
  haveAuthoritativeSnapshot: boolean;
  deviceId: string;
  serverFiles: Record<string, string>;
  serverAssets: Record<string, SnapshotAsset>;
  /** Folders the server already holds. */
  serverFolders: readonly string[];
  assetIdForPath: (path: string) => string;
  localFiles: readonly LocalEntry[];
  /** Local folders no synchronized note implies. Empty when unsupported. */
  localFolders: readonly string[];
}): BootstrapPlan {
  const { deviceId } = params;
  if (!deviceId) {
    return { ok: false, reason: 'NO_DEVICE' };
  }
  if (!params.haveAuthoritativeSnapshot) {
    // Without the server's file map every local file looks absent, so
    // uploading here would push this device's whole vault over the shared
    // one. Refuse instead and let the next sync, or an explicit rescan, try
    // again.
    return { ok: false, reason: 'NO_AUTHORITATIVE_SNAPSHOT' };
  }

  const drafts: OperationDraft[] = [];
  for (const entry of params.localFiles) {
    if (entry.kind === 'skipped') {
      continue;
    }
    if (entry.kind === 'binary') {
      // Binary files are tracked in the asset metadata, never in the file
      // map, so the snapshot says nothing about them unless it listed them.
      const serverAsset = params.serverAssets[entry.path];
      if (serverAsset && serverAsset.hash === entry.hash) {
        continue;
      }
      drafts.push({
        type: 'add-asset',
        payload: {
          path: entry.path,
          assetId: params.assetIdForPath(entry.path),
          hash: entry.hash,
          size: entry.size,
          ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
        },
      });
      continue;
    }
    const serverContent = params.serverFiles[entry.path];
    if (serverContent === undefined) {
      drafts.push({
        type: 'create-note',
        payload: { path: entry.path, content: entry.content },
      });
      continue;
    }
    if (serverContent !== entry.content) {
      drafts.push({
        type: 'replace-content',
        payload: { path: entry.path, content: entry.content },
      });
    }
  }
  // Folders are diffed separately because they carry no content to compare:
  // a folder the server already holds is simply not sent again. Creating one
  // it already has is a no-op, so this costs nothing when the two sides
  // disagree, which is why it needs no hash the way an asset does.
  const knownFolders = new Set(params.serverFolders);
  for (const path of params.localFolders) {
    if (knownFolders.has(path)) {
      continue;
    }
    drafts.push({
      type: 'create-folder',
      payload: { path },
    });
  }
  return { ok: true, drafts };
}
