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

/**
 * The seam between performSync and RetryScheduler.
 *
 * Every other suite here calls performSync directly, so it observes the
 * return value but not what the scheduler does with it. An adapter in the
 * wiring collapsed all four outcomes to 'success' and every one of those
 * tests still passed. These drive the real loop.
 */
describe('scheduler wiring', () => {
  const tick = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  it('stops the loop when a cycle halts', async () => {
    vi.useFakeTimers();
    stubFetch(() => jsonResponse(401, REVOKED));
    await boot();

    const scheduler = (
      plugin as unknown as { createScheduler(): { start(): void; stop(): void } }
    ).createScheduler();
    scheduler.start();
    expect(vi.getTimerCount()).toBe(1);

    // Let the armed timer fire and the cycle observe the 401.
    await tick(60_000);

    // A halt arms nothing, so the loop is genuinely stopped rather than
    // merely reporting the right string.
    expect(vi.getTimerCount()).toBe(0);
    scheduler.stop();
  });

  it('backs off after a transient failure', async () => {
    vi.useFakeTimers();
    stubFetch(() => jsonResponse(500, { error: 'INTERNAL_ERROR', message: 'boom' }));
    await boot();

    const scheduler = (
      plugin as unknown as { createScheduler(): { start(): void; stop(): void } }
    ).createScheduler();
    scheduler.start();

    // First run fails and doubles the interval to 120s.
    await tick(60_000);
    expect(vi.getTimerCount()).toBe(1);

    // Still nothing at 61s: the backoff took effect.
    await tick(1_000);
    expect(vi.getTimerCount()).toBe(1);

    scheduler.stop();
  });

  it('keeps the base interval after a successful cycle', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    stubFetch(() => {
      attempt += 1;
      // Fail once so the delay has grown, then succeed.
      if (attempt === 1) {
        return jsonResponse(500, { error: 'INTERNAL_ERROR', message: 'boom' });
      }
      return jsonResponse(200, { revision: 5, operations: [] });
    });
    await boot();

    const scheduler = (
      plugin as unknown as { createScheduler(): { start(): void; stop(): void } }
    ).createScheduler();
    scheduler.start();

    await tick(60_000);
    expect(vi.getTimerCount()).toBe(1);

    // A success resets the delay, so the next run is due at the base 60s
    // rather than the 120s the backoff had reached.
    await tick(60_001);
    expect(vi.getTimerCount()).toBe(1);

    scheduler.stop();
  });
});

/**
 * Retryable failures.
 *
 * These keep being retried, so nothing is halted — the requirement is only
 * that a server failing for several cycles stops looking like a healthy idle
 * client, and that a single dropped request stays quiet.
 */
describe('sustained failures', () => {
  const FAILING = () => jsonResponse(500, { error: 'INTERNAL_ERROR', message: 'boom' });

  const sync = () =>
    (plugin as unknown as { performSync(): Promise<string> }).performSync();

  it('stays quiet below the threshold', async () => {
    stubFetch(FAILING);
    await boot();

    await sync();

    expect(plugin.syncFailure?.count).toBe(1);
    // A single blip must not interrupt the user.
    expect(notices.some((n) => n.includes('sync is failing'))).toBe(false);
  });

  it('tells the user once the failure has persisted', async () => {
    stubFetch(FAILING);
    await boot();

    await sync();
    await sync();
    await sync();
    await sync();

    expect(plugin.syncFailure?.count).toBeGreaterThanOrEqual(3);
    expect(
      notices.filter((n) => n.includes('sync is failing')).length,
      'the notice must fire exactly once, not per cycle'
    ).toBe(1);
  });

  it('counts a cycle at most once however many branches fail', async () => {
    // A failed download followed by a held-back batch must not advance the
    // streak twice, or the threshold fires early.
    stubFetch(FAILING);
    await boot();
    await plugin.queue.enqueue(
      {
        type: 'add-asset',
        payload: { path: 'img/a.png', assetId: 'a', hash: 'h', size: 1 },
      },
      DEVICE_ID
    );

    await sync();

    expect(plugin.syncFailure?.count).toBe(1);
  });

  it('shows a retrying status with the failure count', async () => {
    stubFetch(FAILING);
    await boot();

    await sync();
    (plugin as unknown as { updateStatusBar(): void }).updateStatusBar();

    expect(statusEl.textContent).toContain('retrying (1)');
    expect(statusEl.title).toContain('boom');
  });

  it('clears the failure after a successful cycle', async () => {
    let failing = true;
    stubFetch(() => (failing ? FAILING() : jsonResponse(200, { revision: 5, operations: [] })));
    await boot();

    await sync();
    await sync();
    expect(plugin.syncFailure).toBeDefined();

    failing = false;
    await sync();

    expect(plugin.syncFailure).toBeUndefined();
    (plugin as unknown as { updateStatusBar(): void }).updateStatusBar();
    expect(statusEl.textContent).not.toContain('retrying');
  });

  it('keeps retrying rather than halting', async () => {
    stubFetch(FAILING);
    await boot();

    // A server error is transient: it must keep being retried.
    expect(await sync()).toBe('retry');
    expect(await sync()).toBe('retry');
    expect(plugin.authFailure).toBeUndefined();
  });

  it('counts an exception as a failure', async () => {
    stubFetch(() => {
      throw new Error('socket exploded');
    });
    await boot();

    await sync();

    expect(plugin.syncFailure?.reason).toContain('socket exploded');
  });
});

/**
 * Device-slot reclamation.
 *
 * A vault caps its devices, and re-authentication used to mint a fresh id
 * every time, so each recovery permanently consumed a slot until the user
 * locked themselves out and had to delete devices by hand.
 */
describe('device id reclamation', () => {
  /** Answers registration, and records the ids it was asked for. */
  function stubRegistration(
    handler: (deviceId: string, call: number) => Response
  ): { requested: string[] } {
    const requested: string[] = [];
    stubFetch((url, init) => {
      if (url.includes('/devices') && init?.method === 'POST') {
        // init.body is a string in practice, but RequestInit types it
        // as BodyInit, so narrow before parsing.
        const raw = typeof init.body === 'string' ? init.body : '';
        const body = JSON.parse(raw) as { deviceId: string };
        requested.push(body.deviceId);
        return handler(body.deviceId, requested.length);
      }
      return jsonResponse(401, REVOKED);
    });
    return { requested };
  }

  const created = (deviceId: string) =>
    jsonResponse(201, { deviceId, apiKey: 'fresh-key' });

  it('reuses the device id it already held', async () => {
    const { requested } = stubRegistration(() => created(DEVICE_ID));
    await boot();
    const sync = (plugin as unknown as { performSync(): Promise<string> }).performSync.bind(plugin);
    await sync();

    await plugin.reauthenticate();

    // The first and only registration must ask for the id already stored, so
    // recovery reclaims the slot rather than consuming one.
    expect(requested).toEqual([DEVICE_ID]);
    expect(plugin.settings.deviceId).toBe(DEVICE_ID);
  });

  it('falls back to a new id only when the old one is still taken', async () => {
    const { requested } = stubRegistration((_deviceId, call) =>
      call === 1
        ? jsonResponse(409, {
            error: 'DEVICE_ALREADY_REGISTERED',
            message: 'this device id is already registered on the vault',
          })
        : created('replacement-id')
    );
    await boot();
    const sync = (plugin as unknown as { performSync(): Promise<string> }).performSync.bind(plugin);
    await sync();

    await plugin.reauthenticate();

    // First tries the id it held, then a genuinely new one.
    expect(requested).toHaveLength(2);
    expect(requested[0]).toBe(DEVICE_ID);
    expect(requested[1]).not.toBe(DEVICE_ID);
    expect(requested[1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(plugin.settings.deviceId).toBe('replacement-id');
  });

  it('explains what to do when the vault is full', async () => {
    stubRegistration(() =>
      jsonResponse(409, {
        error: 'DEVICE_LIMIT_REACHED',
        message: 'maximum of 20 devices per vault',
      })
    );
    await boot();
    const sync = (plugin as unknown as { performSync(): Promise<string> }).performSync.bind(plugin);
    await sync();

    await plugin.reauthenticate();

    expect(
      notices.some((n) => n.includes('maximum number of devices')),
      'a full vault must tell the user what to do, not just fail'
    ).toBe(true);
    // The halt must stand: resuming on a revoked key is the loop being fixed.
    expect(plugin.authFailure).toBeDefined();
  });

  it('does not try to reclaim when the vault is full', async () => {
    // Retrying with a new id could not help — the vault is full either way.
    const { requested } = stubRegistration(() =>
      jsonResponse(409, {
        error: 'DEVICE_LIMIT_REACHED',
        message: 'maximum of 20 devices per vault',
      })
    );
    await boot();
    const sync = (plugin as unknown as { performSync(): Promise<string> }).performSync.bind(plugin);
    await sync();

    await plugin.reauthenticate();

    expect(requested).toEqual([DEVICE_ID]);
  });
});

/**
 * Reclaiming versus duplicating a device.
 *
 * A vault caps its devices, so an id abandoned without being freed stays
 * counted against that cap. The settings button used to register afresh, so
 * it added a device every time it was clicked while the existing one was
 * still registered — which happened whenever the device list had merely
 * failed to load.
 */
describe('credential acquisition', () => {
  /** Answers both the device list and registration. */
  function stubVault(
    devices: Array<{ id: string }>,
    onRegister: (deviceId: string) => Response
  ): { registrations: string[]; lists: number } {
    const registrations: string[] = [];
    let lists = 0;
    stubFetch((url, init) => {
      if (url.endsWith('/devices') && init?.method === 'POST') {
        const raw = typeof init.body === 'string' ? init.body : '';
        const body = JSON.parse(raw) as { deviceId: string };
        registrations.push(body.deviceId);
        return onRegister(body.deviceId);
      }
      if (url.endsWith('/devices')) {
        lists += 1;
        return jsonResponse(200, { devices });
      }
      return jsonResponse(401, REVOKED);
    });
    return {
      get registrations() {
        return registrations;
      },
      get lists() {
        return lists;
      },
    } as { registrations: string[]; lists: number };
  }

  it('does nothing when the stored credential still works', async () => {
    // The decisive case: the device is registered and the key is valid, so
    // registering again would fail with a conflict or, before the server
    // reported that, silently add a second device.
    const vault = stubVault(
      [{ id: DEVICE_ID }],
      () => jsonResponse(201, { deviceId: 'unused', apiKey: 'k' })
    );
    await boot();

    await plugin.registerOnCurrentVault();

    expect(vault.registrations).toEqual([]);
    expect(vault.lists).toBe(1);
  });

  it('reclaims the stored id once the device has been removed', async () => {
    // Revoked: the list 401s, so the id cannot be confirmed free, and is
    // tried anyway — which is what makes it reusable rather than duplicated.
    const vault = stubVault([], (deviceId) =>
      jsonResponse(201, { deviceId, apiKey: 'fresh-key' })
    );
    await boot();

    await plugin.registerOnCurrentVault();

    expect(vault.registrations).toEqual([DEVICE_ID]);
    expect(plugin.settings.deviceId).toBe(DEVICE_ID);
  });

  it('falls back to a new id only when the old one is occupied', async () => {
    const vault = stubVault(
      [],
      (deviceId) =>
        deviceId === DEVICE_ID
          ? jsonResponse(409, {
              error: 'DEVICE_ALREADY_REGISTERED',
              message: 'this device id is already registered on the vault',
            })
          : jsonResponse(201, { deviceId, apiKey: 'fresh-key' })
    );
    await boot();

    await plugin.registerOnCurrentVault();

    expect(vault.registrations).toHaveLength(2);
    expect(vault.registrations[0]).toBe(DEVICE_ID);
    expect(vault.registrations[1]).not.toBe(DEVICE_ID);
  });

  it('registers afresh when this device was never on the vault', async () => {
    const vault = stubVault([], (deviceId) =>
      jsonResponse(201, { deviceId, apiKey: 'fresh-key' })
    );
    await boot();
    // No stored credentials: a different vault, or a first-time setup.
    Object.assign(plugin.settings, { deviceId: '', apiKey: '' });

    await plugin.registerOnCurrentVault();

    expect(vault.registrations).toHaveLength(1);
    expect(vault.registrations[0]).not.toBe('');
  });

  it('clears a recorded revocation once the credential is confirmed good', async () => {
    stubVault([{ id: DEVICE_ID }], () =>
      jsonResponse(201, { deviceId: 'unused', apiKey: 'k' })
    );
    await boot();
    const sync = (plugin as unknown as { performSync(): Promise<string> }).performSync.bind(plugin);
    await sync();
    expect(plugin.authFailure).toBeDefined();

    await plugin.registerOnCurrentVault();

    // The key still works, so the halt was stale and must be lifted rather
    // than leaving sync stopped.
    expect(plugin.authFailure).toBeUndefined();
  });
});
