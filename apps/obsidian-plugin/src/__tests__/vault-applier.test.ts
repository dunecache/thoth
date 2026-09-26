import { describe, expect, it } from 'vitest';

import {
  applyOperationToVault,
  applySnapshotToVault,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  isBinaryPath,
} from '../vault-applier.js';
import type { Operation } from '@thoth/protocol';

class MemVault {
  files = new Map<string, string>();
  binaries = new Map<string, ArrayBuffer>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.binaries.has(path);
  }
  async read(path: string): Promise<string> {
    return this.files.get(path) ?? '';
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    return this.binaries.get(path) ?? new ArrayBuffer(0);
  }
  async create(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async createBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.binaries.set(path, data);
  }
  async modify(file: { path: string }, content: string): Promise<void> {
    this.files.set(file.path, content);
  }
  async modifyBinary(file: { path: string }, data: ArrayBuffer): Promise<void> {
    this.binaries.set(file.path, data);
  }
  async rename(file: { path: string }, newPath: string): Promise<void> {
    if (this.files.has(file.path)) {
      const v = this.files.get(file.path) as string;
      this.files.delete(file.path);
      this.files.set(newPath, v);
    }
    if (this.binaries.has(file.path)) {
      const v = this.binaries.get(file.path) as ArrayBuffer;
      this.binaries.delete(file.path);
      this.binaries.set(newPath, v);
    }
  }
  async delete(path: string): Promise<void> {
    this.files.delete(path);
    this.binaries.delete(path);
  }
}

function op(overrides: Partial<Operation> & { type: Operation['type']; payload: any }): Operation {
  return {
    id: 'op-1',
    deviceId: 'dev-1',
    revision: 0,
    ...overrides,
  };
}

describe('isBinaryPath', () => {
  it('detects binary extensions', () => {
    expect(isBinaryPath('a.png')).toBe(true);
    expect(isBinaryPath('a.PDF')).toBe(true);
    expect(isBinaryPath('a.md')).toBe(false);
    expect(isBinaryPath('noext')).toBe(false);
  });
});

describe('base64 round-trip', () => {
  it('encodes and decodes', () => {
    const buf = new TextEncoder().encode('hello binary \x00\x01').buffer;
    const b64 = arrayBufferToBase64(buf);
    const out = base64ToArrayBuffer(b64);
    expect(new Uint8Array(out)).toEqual(new Uint8Array(buf));
  });
});

describe('applyOperationToVault', () => {
  it('creates text note', async () => {
    const v = new MemVault();
    await applyOperationToVault(v, op({ type: 'create-note', payload: { path: 'a.md', content: 'hi' } }));
    expect(v.files.get('a.md')).toBe('hi');
  });

  it('creates binary via base64 fallback', async () => {
    const v = new MemVault();
    const buf = new TextEncoder().encode('pngdata').buffer;
    const b64 = arrayBufferToBase64(buf);
    await applyOperationToVault(v, op({ type: 'create-note', payload: { path: 'img.png', content: b64 } }));
    expect(new Uint8Array(v.binaries.get('img.png') as ArrayBuffer)).toEqual(new Uint8Array(buf));
  });

  it('applies add-asset with fetchAsset', async () => {
    const v = new MemVault();
    const buf = new TextEncoder().encode('asset bytes').buffer;
    const fetchAsset = async () => buf;
    await applyOperationToVault(
      v,
      op({ type: 'add-asset', payload: { path: 'photo.jpg', assetId: 'photo.jpg', hash: 'h', size: buf.byteLength } }),
      { fetchAsset }
    );
    expect(new Uint8Array(v.binaries.get('photo.jpg') as ArrayBuffer)).toEqual(new Uint8Array(buf));
  });

  it('applies delete-asset', async () => {
    const v = new MemVault();
    v.binaries.set('old.png', new ArrayBuffer(2));
    await applyOperationToVault(v, op({ type: 'delete-asset', payload: { path: 'old.png', assetId: 'old.png' } }));
    expect(v.binaries.has('old.png')).toBe(false);
  });

  it('renames any file', async () => {
    const v = new MemVault();
    v.files.set('a.md', 'x');
    await applyOperationToVault(v, op({ type: 'rename-note', payload: { oldPath: 'a.md', newPath: 'b.md' } }));
    expect(v.files.has('b.md')).toBe(true);
  });
});

describe('applySnapshotToVault', () => {
  it('writes text and binary', async () => {
    const v = new MemVault();
    const buf = new TextEncoder().encode('snap').buffer;
    const b64 = arrayBufferToBase64(buf);
    await applySnapshotToVault(v, { 'a.md': 'hello', 'img.png': b64 });
    expect(v.files.get('a.md')).toBe('hello');
    expect(new Uint8Array(v.binaries.get('img.png') as ArrayBuffer)).toEqual(new Uint8Array(buf));
  });
});
