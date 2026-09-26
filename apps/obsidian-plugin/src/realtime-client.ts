/**
 * Real-time vault change notifications via WebSocket + DO hibernation.
 *
 * Connects to wss://<server>/vaults/<vaultId>/ws using a short-lived
 * single-use ticket obtained from /ws-ticket. On a valid
 * {type:'vault-changed', revision} message, the caller is notified.
 * Reconnects with exponential backoff + jitter.
 */

import { realtimeServerMessageSchema } from '@thoth/validation';

import { jsonHeaders } from './auth.js';
import { withJitter } from './backoff.js';

const PING_INTERVAL_MS = 30_000;
const DEBOUNCE_MS = 250;

export type RealtimeStatus = 'connecting' | 'open' | 'closed';

export interface RealtimeOptions {
  serverUrl: string;
  vaultId: string;
  deviceId: string;
  apiKey: string;
  getLocalRevision: () => number;
  requestSync: () => void;
  onStatusChange: (status: RealtimeStatus) => void;
  webSocketFactory?: (url: string) => WebSocket;
}

interface InternalState {
  ws?: WebSocket;
  pingTimer?: ReturnType<typeof setInterval>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  lastSeenRevision: number;
  debounceTimer?: ReturnType<typeof setTimeout>;
  backoffMs: number;
  closed: boolean;
}

function baseUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '');
}

/**
 * Validates a server frame, returning the revision it announces.
 *
 * Uses the shared schema so the plugin cannot drift from what the server
 * actually sends, and returns null for anything else rather than trusting
 * the parsed shape.
 */
function parseServerMessage(raw: unknown): { revision: number } | null {
  if (typeof raw !== 'string') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = realtimeServerMessageSchema(parsed);
  if (!result.ok || result.value.type !== 'vault-changed') {
    return null;
  }
  return { revision: result.value.revision };
}

function wsUrlFromHttp(url: string): string {
  if (url.startsWith('http://')) return 'ws://' + url.slice(7);
  if (url.startsWith('https://')) return 'wss://' + url.slice(8);
  return url;
}

type TicketResult =
  | { ok: true; ticket: string }
  | { ok: false; reason: 'unauthorized' | 'network' };

async function fetchTicket(params: {
  serverUrl: string;
  vaultId: string;
  deviceId: string;
  apiKey: string;
}): Promise<TicketResult> {
  try {
    const res = await fetch(
      `${baseUrl(params.serverUrl)}/vaults/${encodeURIComponent(params.vaultId)}/ws-ticket`,
      {
        method: 'POST',
        headers: jsonHeaders(params.apiKey),
        body: JSON.stringify({
          deviceId: params.deviceId,
          apiKey: params.apiKey,
        }),
      }
    );
    if (res.status === 401 || res.status === 403) {
      // Bad or rotated credentials: reconnecting cannot help until the user
      // re-registers, so stop instead of hammering the server.
      return { ok: false, reason: 'unauthorized' };
    }
    if (!res.ok) {
      // Server reachable but refusing for another reason (rate limit, vault
      // missing). Worth retrying.
      return { ok: false, reason: 'network' };
    }
    const body = (await res.json()) as { ticket?: string };
    if (!body.ticket) {
      return { ok: false, reason: 'network' };
    }
    return { ok: true, ticket: body.ticket };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

export function connectRealtime(options: RealtimeOptions) {
  const {
    serverUrl,
    vaultId,
    deviceId,
    apiKey,
    getLocalRevision,
    requestSync,
    onStatusChange,
    webSocketFactory = (url) => new WebSocket(url),
  } = options;

  const state: InternalState = {
    lastSeenRevision: getLocalRevision(),
    backoffMs: 1_000,
    closed: false,
  };

  let status: RealtimeStatus = 'closed';

  const setStatus = (s: RealtimeStatus) => {
    if (status !== s) {
      status = s;
      onStatusChange(s);
    }
  };

  const scheduleSync = () => {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      requestSync();
    }, DEBOUNCE_MS);
  };

  const connect = async () => {
    if (state.closed) return;
    setStatus('connecting');
    const ticket = await fetchTicket({ serverUrl, vaultId, deviceId, apiKey });
    if (!ticket.ok) {
      if (ticket.reason === 'unauthorized') {
        // Credentials are rejected; only re-registering can fix this, and the
        // plugin recreates this client when settings change.
        console.debug('Thoth: realtime ticket rejected, not reconnecting');
        setStatus('closed');
        return;
      }
      // A transient failure — offline, DNS, server restart — must not leave
      // realtime dead until the plugin is reloaded.
      scheduleReconnect();
      return;
    }
    const url = `${wsUrlFromHttp(baseUrl(serverUrl))}/vaults/${encodeURIComponent(vaultId)}/ws?deviceId=${encodeURIComponent(deviceId)}&ticket=${encodeURIComponent(ticket.ticket)}`;
    let ws: WebSocket;
    try {
      ws = webSocketFactory(url);
    } catch {
      scheduleReconnect();
      return;
    }
    state.ws = ws;

    ws.onopen = () => {
      setStatus('open');
      state.backoffMs = 1_000;
      if (state.pingTimer) clearInterval(state.pingTimer);
      state.pingTimer = setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // Socket closed between the tick firing and the send; onclose
          // handles the reconnect.
        }
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (ev) => {
      const data = parseServerMessage(ev.data);
      if (!data) {
        // Unparseable or unknown frame: the server is trusted to send valid
        // ones, so there is nothing to act on.
        return;
      }
      const local = getLocalRevision();
      if (data.revision > local && data.revision > state.lastSeenRevision) {
        state.lastSeenRevision = data.revision;
        scheduleSync();
      }
    };

    ws.onclose = () => {
      setStatus('closed');
      if (state.pingTimer) {
        clearInterval(state.pingTimer);
        state.pingTimer = undefined;
      }
      if (!state.closed) scheduleReconnect();
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // Already closed; onclose has run or is about to.
      }
    };
  };

  const scheduleReconnect = () => {
    if (state.closed) return;
    const delay = withJitter(Math.min(state.backoffMs, 60_000));
    state.backoffMs = Math.min(state.backoffMs * 2, 60_000);
    state.reconnectTimer = setTimeout(() => {
      void connect();
    }, delay);
  };

  // initial connect
  void connect();

  return {
    close() {
      state.closed = true;
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      if (state.pingTimer) clearInterval(state.pingTimer);
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      try {
        state.ws?.close();
      } catch {
        // Already closed.
      }
      setStatus('closed');
    },
  };
}
