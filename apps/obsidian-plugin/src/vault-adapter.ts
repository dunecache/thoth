/**
 * Obsidian implementation of the vault adapter the applier writes through.
 *
 * This lives outside the plugin class so it can be tested against a vault
 * stub. As a private method on the plugin it had no coverage at all, which
 * is how `rename` shipped without creating the destination's parent folders.
 */

import { TAbstractFile, TFile, TFolder } from 'obsidian';

import type { ApplyGuard } from './apply-guard.js';
import type { VaultAdapter } from './vault-applier.js';
import { hashArrayBuffer } from './vault-applier.js';

/**
 * The subset of Obsidian's Vault API this adapter uses.
 *
 * Declared structurally rather than importing `Vault` so tests can supply a
 * stub without reproducing the whole interface, matching the narrow-interface
 * rationale in vault-applier.ts.
 */
export interface ObsidianVault {
  getAbstractFileByPath(path: string): TAbstractFile | null;
  createFolder(path: string): Promise<unknown>;
  create(path: string, data: string): Promise<unknown>;
  createBinary(path: string, data: ArrayBuffer): Promise<unknown>;
  modify(file: TFile, data: string): Promise<unknown>;
  modifyBinary(file: TFile, data: ArrayBuffer): Promise<unknown>;
  read(file: TFile): Promise<string>;
  readBinary(file: TFile): Promise<ArrayBuffer>;
  rename(file: TAbstractFile, newPath: string): Promise<unknown>;
  delete(file: TAbstractFile): Promise<unknown>;
}

/** Raised when a path that must be a folder is occupied by a file. */
export class VaultPathConflictError extends Error {
  readonly folderPath: string;

  constructor(folderPath: string) {
    super(
      `Cannot create folder "${folderPath}": a file already exists at that path`
    );
    this.name = 'VaultPathConflictError';
    this.folderPath = folderPath;
  }
}

/**
 * Creates every missing ancestor folder of `path`.
 *
 * Obsidian's own `create`/`rename` reject a path whose parent does not exist,
 * so anything that writes to a *new* path must create its parents first.
 * `rename` previously skipped this, which is why moving a note into a new
 * folder failed on the receiving device.
 */
async function ensureFolders(
  vault: ObsidianVault,
  path: string
): Promise<void> {
  const parts = path.split('/');
  parts.pop();
  let folderPath = '';
  for (const part of parts) {
    folderPath = folderPath ? `${folderPath}/${part}` : part;
    const existing = vault.getAbstractFileByPath(folderPath);
    if (!existing) {
      await vault.createFolder(folderPath);
      continue;
    }
    if (!(existing instanceof TFolder)) {
      throw new VaultPathConflictError(folderPath);
    }
  }
}

export function createObsidianVaultAdapter(
  vault: ObsidianVault,
  applyGuard: ApplyGuard
): VaultAdapter {
  // Obsidian's read/modify/rename take a TFile, but getAbstractFileByPath
  // returns a TAbstractFile that may be a folder. Resolving to a TFile here
  // keeps the cast in one place instead of at every call site.
  const fileAt = (path: string): TFile | null => {
    const file = vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  };
  return {
    exists: (path: string) =>
      Promise.resolve(vault.getAbstractFileByPath(path) !== null),
    read: async (path: string) => {
      const file = fileAt(path);
      if (!file) {
        throw new Error(`File not found: ${path}`);
      }
      return await vault.read(file);
    },
    readBinary: async (path: string) => {
      const file = fileAt(path);
      if (!file) {
        throw new Error(`File not found: ${path}`);
      }
      return await vault.readBinary(file);
    },
    create: async (path: string, content: string) => {
      await ensureFolders(vault, path);
      applyGuard.recordText(path, content);
      await vault.create(path, content);
    },
    createBinary: async (path: string, data: ArrayBuffer) => {
      await ensureFolders(vault, path);
      applyGuard.recordBinary(path, await hashArrayBuffer(data));
      await vault.createBinary(path, data);
    },
    modify: async (file: { path: string }, content: string) => {
      const f = fileAt(file.path);
      if (f) {
        applyGuard.recordText(file.path, content);
        await vault.modify(f, content);
      }
    },
    modifyBinary: async (file: { path: string }, data: ArrayBuffer) => {
      const f = fileAt(file.path);
      if (f) {
        applyGuard.recordBinary(file.path, await hashArrayBuffer(data));
        await vault.modifyBinary(f, data);
      }
    },
    rename: async (file: { path: string }, newPath: string) => {
      const existing = vault.getAbstractFileByPath(file.path);
      // Renaming something that is already gone is a no-op, matching the
      // applier's own `exists` guard. Checked before ensureFolders so a
      // no-op rename does not leave stray empty folders behind.
      if (!existing) {
        return;
      }
      await ensureFolders(vault, newPath);
      applyGuard.recordPath(file.path);
      applyGuard.recordPath(newPath);
      await vault.rename(existing, newPath);
    },
    delete: async (path: string) => {
      const file = vault.getAbstractFileByPath(path);
      if (file) {
        applyGuard.recordPath(path);
        await vault.delete(file);
      }
    },
  };
}