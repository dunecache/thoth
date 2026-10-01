/**
 * In-memory vault with real folder semantics.
 *
 * The flat `Map` fixtures used elsewhere in the suite cannot catch a missing
 * parent directory: they accept any path, so an adapter that forgot to create
 * folders still passed. This stub enforces the constraint Obsidian actually
 * has — `create` and `rename` reject a path whose parent folder does not
 * exist — so that class of bug fails here.
 */

import { TFile, TFolder } from 'obsidian';

import type { ObsidianVault } from '../vault-adapter.js';

export class MemoryVault implements ObsidianVault {
  readonly files = new Map<string, string>();
  readonly binaries = new Map<string, ArrayBuffer>();
  readonly folders = new Set<string>();

  /** Every mutating call, in order, as `op:path`, for assertions. */
  readonly calls: string[] = [];

  /** Set to make the next call matching the predicate throw. */
  failOn: ((label: string, path: string) => boolean) | undefined;

  private record(label: string, path: string, display = path): void {
    this.calls.push(`${label}:${display}`);
    if (this.failOn?.(label, path)) {
      throw new Error(`simulated ${label} failure at ${path}`);
    }
  }

  /** Mirrors Obsidian: the parent folder must already exist. */
  private requireParent(path: string): void {
    const parent = path.split('/').slice(0, -1).join('/');
    if (parent !== '' && !this.folders.has(parent)) {
      throw new Error(`Folder not found: ${parent}`);
    }
  }

  private addFolderWithAncestors(path: string): void {
    const parts = path.split('/');
    let current = '';
    for (const part of parts) {
      current = current === '' ? part : `${current}/${part}`;
      this.folders.add(current);
    }
  }

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    if (this.files.has(path) || this.binaries.has(path)) {
      const file = new TFile();
      file.path = path;
      file.name = path.split('/').pop() ?? path;
      const dot = file.name.lastIndexOf('.');
      file.extension = dot === -1 ? '' : file.name.slice(dot + 1);
      return file;
    }
    if (this.folders.has(path)) {
      const folder = new TFolder();
      folder.path = path;
      folder.name = path.split('/').pop() ?? path;
      return folder;
    }
    return null;
  }

  createFolder(path: string): Promise<void> {
    this.record('createFolder', path);
    if (this.files.has(path)) {
      throw new Error(`a file already exists at ${path}`);
    }
    this.addFolderWithAncestors(path);
    return Promise.resolve();
  }

  create(path: string, data: string): Promise<TFile> {
    this.record('create', path);
    this.requireParent(path);
    this.files.set(path, data);
    return Promise.resolve(this.getAbstractFileByPath(path) as TFile);
  }

  createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    this.record('createBinary', path);
    this.requireParent(path);
    this.binaries.set(path, data);
    return Promise.resolve(this.getAbstractFileByPath(path) as TFile);
  }

  modify(file: TFile, data: string): Promise<void> {
    this.record('modify', file.path);
    this.files.set(file.path, data);
    return Promise.resolve();
  }

  modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    this.record('modifyBinary', file.path);
    this.binaries.set(file.path, data);
    return Promise.resolve();
  }

  read(file: TFile): Promise<string> {
    return Promise.resolve(this.files.get(file.path) ?? '');
  }

  readBinary(file: TFile): Promise<ArrayBuffer> {
    return Promise.resolve(this.binaries.get(file.path) ?? new ArrayBuffer(0));
  }

  rename(file: TFile | TFolder, newPath: string): Promise<void> {
    const from = file.path;
    this.record('rename', from, `${from}->${newPath}`);
    // The constraint this stub exists to enforce.
    this.requireParent(newPath);
    if (file instanceof TFolder) {
      // Obsidian moves the whole subtree, not just the folder node.
      const prefix = `${from}/`;
      const moved = <T>(map: Map<string, T>, key: string): void => {
        if (key.startsWith(prefix)) {
          const value = map.get(key) as T;
          map.delete(key);
          map.set(newPath + key.slice(from.length), value);
        }
      };
      for (const key of [...this.files.keys()]) moved(this.files, key);
      for (const key of [...this.binaries.keys()]) moved(this.binaries, key);
      for (const key of [...this.folders]) {
        if (key.startsWith(prefix)) {
          this.folders.delete(key);
          this.addFolderWithAncestors(newPath + key.slice(from.length));
        }
      }
      this.folders.delete(from);
      return Promise.resolve();
    }
    const text = this.files.get(from);
    if (text !== undefined) {
      this.files.delete(from);
      this.files.set(newPath, text);
    }
    if (this.binaries.has(from)) {
      const data = this.binaries.get(from) as ArrayBuffer;
      this.binaries.delete(from);
      this.binaries.set(newPath, data);
    }
    return Promise.resolve();
  }

  delete(file: TFile | TFolder): Promise<void> {
    this.record('delete', file.path);
    if (file instanceof TFolder) {
      for (const folder of [...this.folders]) {
        if (folder === file.path || folder.startsWith(`${file.path}/`)) {
          this.folders.delete(folder);
        }
      }
      return Promise.resolve();
    }
    this.files.delete(file.path);
    this.binaries.delete(file.path);
    return Promise.resolve();
  }
}