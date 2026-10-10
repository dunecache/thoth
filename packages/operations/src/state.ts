/**
 * Vault state as seen by the operation engine.
 *
 * A vault state is a revision plus a map of note paths to contents.
 * It is immutable: applying operations produces a new state.
 */

import type { Revision } from '@thoth/protocol';

export interface AssetRecord {
  assetId: string;
  hash: string;
  size: number;
  mimeType?: string;
}

export interface VaultState {
  revision: Revision;
  files: Record<string, string>;
  assets: Record<string, AssetRecord>;
  /**
   * Folders whose existence no file path implies — the ones a user created
   * and expects to still find there, empty.
   *
   * A folder holding files is derived from those paths and is deliberately
   * absent here. Storing every folder would duplicate data that can disagree
   * with itself: the same path in `files` and in `folders`, with no rule for
   * which one wins once a note moves.
   */
  folders: string[];
}

export function createVaultState(): VaultState {
  return { revision: 0, files: {}, assets: {}, folders: [] };
}
