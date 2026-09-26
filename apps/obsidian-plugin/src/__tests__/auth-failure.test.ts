import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Observes the plugin's auth-failure behaviour end to end: a revoked
 * credential must halt syncing, say so exactly once, show in the status bar,
 * and survive re-registration without losing queued work.
 */

// Imported from the stub by path rather than as `obsidian`: vitest aliases
// the specifier to the same file, so the runtime instance is shared with
// main.ts, and TypeScript sees the stub's shape.
import { Notice, pluginStore } from '../test-support/obsidian-stub.js';

import { ThothPlugin } from '../main.js';

const notices = Notice.raised;

const DEVICE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const PERSISTED = {
  settings: {
    serverUrl: 'https://sync.test',
    vaultId: 'vault-1',
    deviceId: DEVICE_ID,
    apiKey: 'stale-key',
    deviceName: 'Test',
    syncedExtensions: ['md'],
    lastVaultIds: [],
  },
  queue: [],
  serverRevision: 5,
};

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: FetchCall[] = [];
let statusEl: { textContent: string; title: string };
let plugin: InstanceType<typeof ThothPlugin>;

/** Minimal stand-ins for the app surface the sync path touches. */
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const REVOKED = {
  error: 'DEVICE_NOT_REGISTERED',
  message: 'this device is no longer registered on the vault',
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
}

async function boot(): Promise<void> {
  pluginStore.data = structuredClone(PERSISTED);
  plugin = new ThothPlugin(createApp() as never, {} as never);
  statusEl = { textContent: '', title: '' };
  // Reach the private element the plugin renders into.
  Object.assign(plugin, { statusBarEl: statusEl });
  await (plugin as unknown as { loadPersisted(): Promise<void> }).loadPersisted();
}

beforeEach(() => {
  notices.length = 0;
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('revoked credential', () => {
  it('halts the sync cycle instead of retrying', async () => {
    stubFetch(() => jsonResponse(401, REVOKED));
    await boot();

    const outcome = await (plugin as unknown as { performSync(): Promise<string> }).performSync();

    expect(outcome).toBe('halt');
    expect(plugin.authFailure?.reason).toBe(REVOKED.message);
  });

  it('shows a single notice across repeated attempts', async () => {
    stubFetch(() => jsonResponse(401, REVOKED));
    await boot();
    const sync = (plugin as unknown as { performSync(): Promise<string> }).performSync.bind(plugin);

    await sync();
    await sync();
    await sync();

    const warnings = notices.filter((n) => n.includes('no longer registered'));
    expect(warnings).toHaveLength(1);
  });

  it('stops issuing requests once halted', async () => {
    stubFetch(() => jsonResponse(401, REVOKED));
    await boot();
    const sync = (plugin as unknown as { performSync(): Promise<string> }).performSync.bind(plugin);

    await sync();
    const afterFirst = calls.length;
    await sync();
    await sync();

    // A halted plugin must not keep hammering a server that said no.
    expect(calls.length).toBe(afterFirst);
  });

  it('surfaces in the status bar ahead of the pending count', async () => {
    stubFetch(() => jsonResponse(401, REVOKED));
    await boot();
    const sync = (plugin as unknown as { performSync(): Promise<string> }).performSync.bind(plugin);
    await sync();

    (plugin as unknown as { updateStatusBar(): void }).updateStatusBar();

    expect(statusEl.textContent).toContain('re-register');
    // The tooltip must name the cause and the fix.
    expect(statusEl.title).toContain(REVOKED.message);
    expect(statusEl.title).toContain('Re-authenticate');
  });

  it('does not halt on a transient failure', async () => {
    stubFetch(() => jsonResponse(500, { error: 'INTERNAL_ERROR', message: 'boom' }));
    await boot();

    const outcome = await (plugin as unknown as { performSync(): Promise<string> }).performSync();

    expect(outcome).toBe('retry');
    expect(plugin.authFailure).toBeUndefined();
  });

  it('does not halt on a revision conflict', async () => {
    stubFetch(() => jsonResponse(409, { error: 'REVISION_MISMATCH', message: 'server is at revision 9' }));
    await boot();

    const outcome = await (plugin as unknown as { performSync(): Promise<string> }).performSync();

    expect(outcome).toBe('retry');
    expect(plugin.authFailure).toBeUndefined();
  });
});

describe('re-authentication', () => {
  it('preserves queued work and resumes syncing', async () => {
    // First cycle: revoked. Then the user re-registers.
    stubFetch((url) => {
      if (url.includes('/devices') && !url.includes('validate')) {
        return jsonResponse(201, {
          deviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          apiKey: 'fresh-key',
        });
      }
      return jsonResponse(401, REVOKED);
    });
    await boot();

    // Give the queue some unsynced work that must survive.
    const queue = plugin.queue;
    await queue.enqueue(
      {
        type: 'create-note',
        payload: { path: 'unsynced.md', content: 'my work' },
      },
      DEVICE_ID
    );
    const queuedBefore = queue.size;
    expect(queuedBefore).toBe(1);

    const sync = (plugin as unknown as { performSync(): Promise<string> }).performSync.bind(plugin);
    await sync();
    expect(plugin.authFailure).toBeDefined();

    await plugin.reauthenticate();

    // The unsynced note is still queued and the halt is cleared.
    expect(plugin.queue.size).toBe(queuedBefore);
    expect(plugin.authFailure).toBeUndefined();
    expect(plugin.settings.apiKey).toBe('fresh-key');
    expect(notices.some((n) => n.includes('resuming sync'))).toBe(true);
  });

  it('keeps the failure state when registration itself fails', async () => {
    stubFetch(() => jsonResponse(401, REVOKED));
    await boot();
    const sync = (plugin as unknown as { performSync(): Promise<string> }).performSync.bind(plugin);
    await sync();

    // Re-registration is refused too — the device is not permitted to rejoin.
    stubFetch(() => jsonResponse(403, { error: 'FORBIDDEN', message: 'not allowed' }));
    await plugin.reauthenticate();

    // The halt stands, so syncing cannot silently resume with a bad key.
    expect(plugin.authFailure).toBeDefined();
    expect(notices.some((n) => n.includes('registration failed'))).toBe(true);
  });

  it('tears down the realtime client so it reconnects with the new key', async () => {
    stubFetch(() => jsonResponse(401, REVOKED));
    await boot();
    await (plugin as unknown as { performSync(): Promise<string> }).performSync();

    const closed: string[] = [];
    Object.assign(plugin, {
      realtimeClient: { close: () => closed.push('closed') },
      realtimeStatus: 'closed',
    });

    stubFetch((url) => {
      if (url.includes('/devices') && !url.includes('validate')) {
        return jsonResponse(201, {
          deviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          apiKey: 'fresh-key',
        });
      }
      return jsonResponse(200, { revision: 5, operations: [] });
    });
    await plugin.reauthenticate();

    // The old client held the revoked key; it must not survive.
    expect(closed).toEqual(['closed']);
    // A fresh client was built, so it will reconnect with the new key.
    expect(plugin.activeRealtimeClient).toBeDefined();
  });
});
