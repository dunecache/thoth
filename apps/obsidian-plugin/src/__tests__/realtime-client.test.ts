import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectRealtime } from '../realtime-client.js';

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(): void {}
  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  FakeSocket.instances = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function ticketResponse(ticket: string): Response {
  return new Response(JSON.stringify({ ticket, expiresAt: Date.now() + 60_000 }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    serverUrl: 'https://sync.test',
    vaultId: 'vault-1',
    deviceId: 'dev-1',
    apiKey: 'key-1',
    getLocalRevision: () => 0,
    requestSync: () => {},
    onStatusChange: () => {},
    webSocketFactory: (url: string) => new FakeSocket(url) as unknown as WebSocket,
    ...overrides,
  };
}

describe('realtime ticket handling', () => {
  it('retries after a transient network failure instead of giving up', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    globalThis.fetch = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('offline');
      }
      return ticketResponse('ticket-1');
    });

    const statuses: string[] = [];
    const client = connectRealtime(
      baseOptions({ onStatusChange: (s: string) => statuses.push(s) })
    );
    await vi.advanceTimersByTimeAsync(0);

    // The first failure must not end the attempt.
    expect(statuses).toContain('connecting');
    expect(attempt).toBe(1);

    // Backoff then retries and the socket is created.
    await vi.advanceTimersByTimeAsync(2000);
    expect(attempt).toBe(2);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0]?.url).toContain('ticket=ticket-1');

    client.close();
  });

  it('retries when the server is reachable but refuses', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    globalThis.fetch = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response('{}', { status: 429 });
      }
      return ticketResponse('ticket-1');
    });

    const client = connectRealtime(baseOptions());
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toBe(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(attempt).toBe(2);
    expect(FakeSocket.instances).toHaveLength(1);

    client.close();
  });

  it('gives up on rejected credentials instead of retrying forever', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
    globalThis.fetch = fetchMock;

    const statuses: string[] = [];
    const client = connectRealtime(
      baseOptions({ onStatusChange: (s: string) => statuses.push(s) })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statuses).toContain('closed');

    // No reconnect is scheduled for a credential failure.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    client.close();
  });

  it('gives up on a 403 as well', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 403 }));
    globalThis.fetch = fetchMock;

    const client = connectRealtime(baseOptions());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    client.close();
  });

  it('does not reconnect after close', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () => ticketResponse('t'));

    const client = connectRealtime(baseOptions());
    await vi.advanceTimersByTimeAsync(0);
    const attemptsWhileOpen = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    client.close();
    await vi.advanceTimersByTimeAsync(120_000);
    const attemptsAfterClose = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(attemptsAfterClose).toBe(attemptsWhileOpen);
  });
});

describe('realtime notifications', () => {
  it('requests a sync when the server reports a newer revision', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () => ticketResponse('t'));

    const requestSync = vi.fn();
    const client = connectRealtime(baseOptions({ requestSync }));
    await vi.advanceTimersByTimeAsync(0);

    const socket = FakeSocket.instances[0];
    socket.open();
    socket.onmessage?.({
      data: JSON.stringify({ type: 'vault-changed', revision: 5 }),
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(requestSync).toHaveBeenCalledTimes(1);

    client.close();
  });

  it('ignores a revision the device already has', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () => ticketResponse('t'));

    const requestSync = vi.fn();
    const client = connectRealtime(
      baseOptions({ requestSync, getLocalRevision: () => 9 })
    );
    await vi.advanceTimersByTimeAsync(0);

    const socket = FakeSocket.instances[0];
    socket.open();
    socket.onmessage?.({
      data: JSON.stringify({ type: 'vault-changed', revision: 4 }),
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(requestSync).not.toHaveBeenCalled();

    client.close();
  });

  it('debounces a burst of notifications into one sync', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () => ticketResponse('t'));

    const requestSync = vi.fn();
    const client = connectRealtime(baseOptions({ requestSync }));
    await vi.advanceTimersByTimeAsync(0);

    const socket = FakeSocket.instances[0];
    socket.open();
    for (const revision of [5, 6, 7]) {
      socket.onmessage?.({
        data: JSON.stringify({ type: 'vault-changed', revision }),
      });
    }

    await vi.advanceTimersByTimeAsync(300);
    expect(requestSync).toHaveBeenCalledTimes(1);

    client.close();
  });
});
