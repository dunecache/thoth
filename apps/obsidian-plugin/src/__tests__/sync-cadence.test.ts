import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The periodic poll is the only thing that drains the queue when realtime is
 * unavailable, so its cadence has to follow the socket's actual state.
 *
 * The interval used to be raised when the realtime client was merely
 * configured, which meant a socket that never opened silently pinned the
 * plugin to a five-minute poll — the "polling" indicator looked healthy while
 * fifteen pending changes sat there.
 */

import { pluginStore } from '../test-support/obsidian-stub.js';
import type { RealtimeOptions } from '../realtime-client.js';

const connectCalls: RealtimeOptions[] = [];

vi.mock('../realtime-client.js', () => ({
  connectRealtime: (options: RealtimeOptions) => {
    connectCalls.push(options);
    return { close: () => {} };
  },
}));

const { ThothPlugin } = await import('../main.js');

const PERSISTED = {
  settings: {
    serverUrl: 'https://sync.test',
    vaultId: 'vault-1',
    deviceId: 'device-1',
    apiKey: 'key-1',
    deviceName: 'Test',
    syncedExtensions: ['md'],
    lastVaultIds: [],
  },
  queue: [],
  serverRevision: 3,
};

interface SchedulerProbe {
  baseIntervalMs: number;
  updateBaseInterval(ms: number): void;
}

function createApp(): unknown {
  return {
    vault: {
      getFiles: () => [],
      getAbstractFileByPath: () => null,
      on: () => ({}),
      offref: () => {},
    },
    workspace: { layoutReady: true, onLayoutReady: () => {} },
  };
}

type PluginInternals = {
  scheduler: SchedulerProbe;
  realtimeStatus: RealtimeStatus;
  ensureRealtimeClient(): void;
};

type RealtimeStatus = 'connecting' | 'open' | 'closed';

async function boot(): Promise<PluginInternals> {
  connectCalls.length = 0;
  pluginStore.data = structuredClone(PERSISTED);
  const plugin = new ThothPlugin(createApp() as never, {} as never);
  Object.assign(plugin, {
    statusBarEl: { textContent: '', title: '' },
    // A probe standing in for the real scheduler: this test is about which
    // interval the plugin asks for, not about timer behaviour.
    scheduler: {
      baseIntervalMs: 60_000,
      updateBaseInterval(this: SchedulerProbe, ms: number) {
        this.baseIntervalMs = ms;
      },
    },
  });
  await (plugin as unknown as { loadPersisted(): Promise<void> }).loadPersisted();
  return plugin as unknown as PluginInternals;
}

describe('sync cadence follows the realtime status', () => {
  let plugin: PluginInternals;

  beforeEach(async () => {
    plugin = await boot();
    plugin.ensureRealtimeClient();
  });

  it('keeps the fast poll until the socket is actually open', () => {
    expect(connectCalls).toHaveLength(1);
    // A freshly configured client has not connected yet.
    expect(plugin.scheduler.baseIntervalMs).toBe(60_000);
  });

  it('slows the poll once the socket opens', () => {
    connectCalls[0]?.onStatusChange('open');

    expect(plugin.scheduler.baseIntervalMs).toBe(300_000);
  });

  it('restores the fast poll when the socket drops', () => {
    connectCalls[0]?.onStatusChange('open');
    expect(plugin.scheduler.baseIntervalMs).toBe(300_000);

    connectCalls[0]?.onStatusChange('closed');

    expect(plugin.scheduler.baseIntervalMs).toBe(60_000);
  });

  it('stays on the fast poll while reconnecting', () => {
    connectCalls[0]?.onStatusChange('open');
    connectCalls[0]?.onStatusChange('connecting');

    expect(plugin.scheduler.baseIntervalMs).toBe(60_000);
  });

  it('is a no-op on cadence when not configured, but still correct', () => {
    const unconfigured = new ThothPlugin(createApp() as never, {} as never);
    Object.assign(unconfigured, {
      statusBarEl: { textContent: '', title: '' },
      scheduler: {
        baseIntervalMs: 300_000,
        updateBaseInterval(this: SchedulerProbe, ms: number) {
          this.baseIntervalMs = ms;
        },
      },
    });
    Object.assign(unconfigured, {
      settings: { ...PERSISTED.settings, apiKey: '', deviceId: '' },
    });

    (unconfigured as unknown as PluginInternals).ensureRealtimeClient();

    expect(
      (unconfigured as unknown as PluginInternals).scheduler.baseIntervalMs
    ).toBe(60_000);
  });
});