import { describe, expect, it } from 'vitest';

import type { Operation } from '@thoth/protocol';

import type { Persistence, PluginData } from '../persistence.js';
import {
  loadPluginData,
  parsePluginData,
  savePluginData,
} from '../persistence.js';

class MemoryPersistence implements Persistence {
  data: unknown;

  constructor(data: unknown = null) {
    this.data = data;
  }

  loadData(): Promise<unknown> {
    return Promise.resolve(this.data);
  }

  saveData(data: unknown): Promise<void> {
    this.data = data;
    return Promise.resolve();
  }
}

function validOperation(revision: number): Operation {
  return {
    id: `op-${revision}`,
    type: 'create-note',
    deviceId: 'dev-1',
    revision,
    payload: { path: `a-${revision}.md`, content: 'x' },
  };
}

describe('parsePluginData', () => {
  it('returns defaults when no data is stored', () => {
    const data = parsePluginData(undefined);
    expect(data.settings).toMatchObject({ serverUrl: '', apiKey: '' });
    expect(data.queue).toEqual([]);
    expect(data.serverRevision).toBe(0);
  });

  it('returns defaults for non-record data', () => {
    expect(parsePluginData('nope').queue).toEqual([]);
    expect(parsePluginData(['a']).queue).toEqual([]);
  });

  it('parses settings and a valid queue', () => {
    const data = parsePluginData({
      settings: { serverUrl: 'https://sync.example.com' },
      queue: [validOperation(0)],
    });

    expect(data.settings.serverUrl).toBe('https://sync.example.com');
    expect(data.queue).toEqual([validOperation(0)]);
    expect(data.serverRevision).toBe(0);
  });

  it('drops malformed queue entries but keeps valid ones', () => {
    const data = parsePluginData({
      queue: [
        validOperation(0),
        {
          id: 'bad',
          type: 'create-note',
          deviceId: 'dev-1',
          revision: 1,
          payload: { path: 'x' },
        }, // missing content
        'junk',
      ],
    });

    expect(data.queue).toEqual([validOperation(0)]);
  });

  it('ignores a non-array queue', () => {
    const data = parsePluginData({ queue: 'nope' });
    expect(data.queue).toEqual([]);
  });
});

describe('loadPluginData', () => {
  it('returns defaults when storage throws', async () => {
    const storage: Persistence = {
      loadData() {
        return Promise.reject(new Error('disk unreadable'));
      },
      saveData() {
        return Promise.resolve();
      },
    };
    const data = await loadPluginData(storage);
    expect(data.queue).toEqual([]);
    expect(data.settings).toMatchObject({ serverUrl: '' });
  });

  it('round-trips a persisted blob', async () => {
    const storage = new MemoryPersistence();
    const expected: PluginData = {
      settings: {
        serverUrl: 'u',
        vaultId: 'v',
        deviceId: 'd',
        apiKey: 'k',
        deviceName: '',
        syncedExtensions: ['md', 'base'],
        lastVaultIds: [],
        lastHealthCheck: undefined,
      },
      queue: [validOperation(1)],
      serverRevision: 42,
    };

    await savePluginData(storage, expected);
    const loaded = await loadPluginData(storage);
    expect(loaded).toEqual(expected);
  });
});
