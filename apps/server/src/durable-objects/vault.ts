import type { DurableObjectState } from '@cloudflare/workers-types';
import type { ValidationIssue } from '@thoth/protocol';
import {
  appendOperation,
  applyOperations,
  createLogWindow,
  createOperationLog,
  createVaultState,
  isCompleteLog,
  logEndRevision,
  type OperationLog,
  type VaultState,
} from '@thoth/operations';
import {
  pullOperationsSchema,
  pushOperationsSchema,
  realtimeClientMessageSchema,
  registerDeviceSchema,
  wsTicketRequestSchema,
} from '@thoth/validation';

interface Device {
  apiKeyHash: string;
  createdAt: number;
  name?: string;
}

interface VaultMetadata {
  id: string;
  devices: Record<string, Device>;
  lastSyncAt?: number;
}

interface AssetMetadata {
  hash: string;
  size: number;
  mimeType?: string;
  uploadedAt: number;
}

interface StoredVault {
  metadata: VaultMetadata;
  log: OperationLog;
  snapshot: VaultState;
  assets: Record<string, AssetMetadata>;
}

/** Structured 400 error matching the protocol ValidationErrorResponse. */
function validationErrorResponse(issues: ValidationIssue[]): Response {
  return new Response(
    JSON.stringify({
      error: 'VALIDATION_ERROR',
      message: 'request body is invalid',
      details: { issues },
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } }
  );
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export class VaultDurableObject {
  private state: DurableObjectState;
  private connections = new Map<
    WebSocket,
    { deviceId: string; lastActive: number }
  >();
  private readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  private readonly ALARM_INTERVAL_MS = 60 * 1000;
  private readonly SNAPSHOT_COMPACTION_THRESHOLD = 500;
  /** Operations retained after compaction for lagging clients. */
  private readonly LOG_WINDOW_SIZE = 200;
  private readonly SNAPSHOT_INTERVAL_MS = 30 * 60 * 1000;
  private readonly MAX_BATCH_SIZE = 100;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    const method = request.method;
    // Versioned endpoints support
    let pathname = url.pathname;
    if (pathname.startsWith('/v1')) {
      pathname = pathname.slice(3) || '/';
      url.pathname = pathname;
    }
    // Rate limiting: simple per-IP counter
    const clientIp = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const rateKey = `rate:${clientIp}`;
    const rate = (await this.state.storage.get<{ count: number; ts: number }>(
      rateKey
    )) ?? { count: 0, ts: Date.now() };
    const now = Date.now();
    if (now - rate.ts > 60_000) {
      rate.count = 0;
      rate.ts = now;
    }
    rate.count += 1;
    await this.state.storage.put(rateKey, rate);
    if (rate.count > 100) {
      return new Response(JSON.stringify({ error: 'TOO_MANY_REQUESTS' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let data = await this.load();

    if (url.pathname === '/init' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as unknown as {
        id?: string;
      };
      if (body.id) {
        data = {
          metadata: { id: body.id, devices: {} },
          log: createOperationLog(),
          snapshot: createVaultState(),
          assets: {},
        };
        await this.save(data);
      }
      return json({ ok: true });
    }

    if (url.pathname === '/purge' && method === 'DELETE') {
      await this.state.storage.delete('vault');
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/metadata' && method === 'GET') {
      return json({
        id: data.metadata.id,
        revision: data.snapshot.revision,
      });
    }

    if (url.pathname === '/diagnostics' && method === 'GET') {
      return json({
        id: data.metadata.id,
        revision: data.snapshot.revision,
        logLength: data.log.operations.length,
        assetCount: Object.keys(data.assets).length,
        lastSyncAt: data.metadata.lastSyncAt ?? null,
        connections: this.connections.size,
      });
    }

    // Vault index for GET /vaults (stored in DO id _vault-index)
    if (url.pathname === '/index/list' && method === 'GET') {
      const list = (await this.state.storage.get<string[]>('index:vaults')) ?? [];
      return json({ vaults: list });
    }
    if (url.pathname === '/index/add' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as { id?: string } | null;
      const id = body?.id?.trim();
      if (!id) return json({ error: 'BAD_REQUEST' }, 400);
      const list = (await this.state.storage.get<string[]>('index:vaults')) ?? [];
      if (!list.includes(id)) {
        list.unshift(id);
        // keep cap 100
        if (list.length > 100) list.length = 100;
        await this.state.storage.put('index:vaults', list);
      }
      return json({ ok: true });
    }

    if (url.pathname === '/snapshot' && method === 'GET') {
      return json({
        revision: data.snapshot.revision,
        files: data.snapshot.files,
        assets: (data.snapshot as VaultState).assets ?? {},
      });
    }

    if (url.pathname === '/snapshot' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as unknown;
      const { snapshotSchema } = await import('@thoth/validation');
      const parsed = snapshotSchema(body);
      if (!parsed.ok) {
        return validationErrorResponse(parsed.issues);
      }
      const snapshot = parsed.value as VaultState & { assets?: Record<string, unknown> };
      // Preserve revision monotonicity
      if (snapshot.revision < data.snapshot.revision) {
        return json({ error: 'BAD_REQUEST', message: 'snapshot revision cannot go backwards' }, 400);
      }
      data.snapshot = { revision: snapshot.revision, files: snapshot.files, assets: (snapshot as unknown as VaultState).assets ?? {} } as VaultState;
      await this.save(data);
      return json({ ok: true, revision: data.snapshot.revision });
    }

    if (url.pathname.startsWith('/assets/') && method === 'PUT') {
      return this.handleAssetUpload(request, data);
    }

    if (url.pathname.startsWith('/assets/') && method === 'GET') {
      return this.handleAssetDownload(request, data);
    }

    if (url.pathname === '/ws-ticket' && method === 'POST') {
      return this.handleWsTicket(request, data);
    }

    if (url.pathname === '/ws' && method === 'GET') {
      return this.handleWsUpgrade(request, data);
    }

    if (url.pathname === '/push' && method === 'POST') {
      return this.handlePush(request, data);
    }

    if (url.pathname === '/pull' && method === 'POST') {
      return this.handlePull(request, data);
    }

    // Device management
    if (url.pathname === '/devices' && method === 'POST') {
      const body = await request.json().catch(() => null);
      const parsed = registerDeviceSchema(body);
      if (!parsed.ok) {
        return validationErrorResponse(parsed.issues);
      }
      const { deviceId: requestedId, name } = parsed.value;
      const MAX_DEVICES = 20;
      if (Object.keys(data.metadata.devices).length >= MAX_DEVICES) {
        return json(
          {
            error: 'DEVICE_LIMIT_REACHED',
            message: `maximum of ${MAX_DEVICES} devices per vault`,
          },
          409
        );
      }
      const deviceId =
        requestedId && !data.metadata.devices[requestedId]
          ? requestedId
          : crypto.randomUUID();
      if (data.metadata.devices[deviceId]) {
        return json(
          {
            error: 'DEVICE_ALREADY_REGISTERED',
            message: 'device id already in use',
          },
          409
        );
      }
      const apiKey = crypto.randomUUID();
      const apiKeyHash = await this.hash(apiKey);
      data.metadata.devices[deviceId] = {
        apiKeyHash,
        createdAt: Date.now(),
        name,
      };
      await this.save(data);
      return json({ deviceId, apiKey }, 201);
    }

    if (url.pathname === '/devices' && method === 'GET') {
      const devices = Object.entries(data.metadata.devices).map(
        ([id, device]) => ({
          id,
          createdAt: device.createdAt,
          name: device.name,
        })
      );
      return json({ devices });
    }

    const deviceMatch = url.pathname.match(/^\/devices\/([^/]+)/);
    if (deviceMatch) {
      const deviceId = deviceMatch[1];
      const device = data.metadata.devices[deviceId];

      if (!device) {
        return json({ error: 'NOT_FOUND' }, 404);
      }

      if (method === 'DELETE') {
        delete data.metadata.devices[deviceId];
        await this.save(data);
        return new Response(null, { status: 204 });
      }

      if (url.pathname === `/devices/${deviceId}/rotate` && method === 'POST') {
        const apiKey = crypto.randomUUID();
        const apiKeyHash = await this.hash(apiKey);
        data.metadata.devices[deviceId] = {
          ...device,
          apiKeyHash,
          createdAt: Date.now(),
        };
        await this.save(data);
        return json({ deviceId, apiKey });
      }

      if (
        url.pathname === `/devices/${deviceId}/validate` &&
        method === 'POST'
      ) {
        const body = (await request.json().catch(() => null)) as unknown as {
          apiKey?: string;
        };
        if (!body.apiKey) {
          return json({ valid: false });
        }
        const hash = await this.hash(body.apiKey);
        return json({ valid: hash === device.apiKeyHash });
      }
    }

    return json({ error: 'NOT_FOUND' }, 404);
  }

  private async handlePush(
    request: Request,
    data: StoredVault
  ): Promise<Response> {
    const body = (await request.json().catch(() => null)) as unknown;
    const parsed = pushOperationsSchema(body);
    if (!parsed.ok) {
      return validationErrorResponse(parsed.issues);
    }

    // Feature flag for device auth on mutating endpoints – disabled by default
    const ENFORCE_DEVICE_AUTH = false;
    if (ENFORCE_DEVICE_AUTH) {
      // TODO: validate Authorization header against devices
    }
    const { baseRevision, operations, protocolVersion } = parsed.value;
    // Client version check / graceful upgrade
    if (protocolVersion && protocolVersion < 1) {
      return json(
        { error: 'UNSUPPORTED_PROTOCOL', message: 'protocol version too old' },
        400
      );
    }
    if (operations.length > this.MAX_BATCH_SIZE) {
      return json(
        {
          error: 'BAD_REQUEST',
          message: `batch size exceeds ${this.MAX_BATCH_SIZE}`,
        },
        400
      );
    }
    const { metadata, log, snapshot } = data;
    // Operation checksum verification
    for (const op of operations) {
      if (op.metadata?.checksum) {
        const payloadHash = await this.hash(JSON.stringify(op.payload));
        if (payloadHash !== op.metadata.checksum) {
          return json(
            { error: 'BAD_REQUEST', message: 'operation checksum mismatch' },
            400
          );
        }
      }
    }

    if (baseRevision !== snapshot.revision) {
      return json(
        {
          error: 'REVISION_MISMATCH',
          message: `server is at revision ${snapshot.revision}`,
          details: { revision: snapshot.revision },
        },
        409
      );
    }
    // Duplicate operation detection & replay protection
    const existingIds = new Set(log.operations.map((op) => op.id));
    const duplicateOps = operations.filter((op) => existingIds.has(op.id));
    if (duplicateOps.length > 0) {
      return json(
        {
          error: 'CONFLICT',
          message: 'duplicate operations detected',
          details: {
            reason: 'DUPLICATE_OPERATION',
            duplicateIds: duplicateOps.map((o) => o.id),
          },
        },
        409
      );
    }

    const applied = applyOperations(snapshot, operations);
    if (!applied.ok) {
      return json(
        {
          error: 'CONFLICT',
          message: `operation rejected: ${applied.error}`,
          details: { reason: applied.error, revision: snapshot.revision },
        },
        409
      );
    }

    let nextLog = log;
    for (const op of operations) {
      const appended = appendOperation(nextLog, op);
      if (!appended.ok) {
        // Unreachable when baseRevision matched: applyOperations verified
        // the batch chains revisions contiguously. Kept as a safety net.
        return json(
          {
            error: 'REVISION_MISMATCH',
            message: 'operation revisions are not contiguous',
          },
          409
        );
      }
      nextLog = appended.log;
    }

    let compactedLog = nextLog;
    // Automatic snapshot compaction
    if (compactedLog.operations.length >= this.SNAPSHOT_COMPACTION_THRESHOLD) {
      compactedLog = this.compactLog(compactedLog, applied.state.revision);
    }

    const updatedMetadata = { ...metadata, lastSyncAt: Date.now() };
    await this.save({
      metadata: updatedMetadata,
      log: compactedLog,
      snapshot: applied.state,
      assets: data.assets,
    });
    // Audit logging
    await this.audit('push', {
      revision: applied.state.revision,
      deviceId: operations[0]?.deviceId,
    });
    // Notify connected clients about the new revision
    const pushingDeviceId = operations[0]?.deviceId;
    await this.broadcastVaultChanged(applied.state.revision, pushingDeviceId);

    return json({ revision: applied.state.revision, capabilities: [] });
  }

  private async handlePull(
    request: Request,
    data: StoredVault
  ): Promise<Response> {
    const body = (await request.json().catch(() => null)) as unknown;
    const parsed = pullOperationsSchema(body);
    if (!parsed.ok) {
      return validationErrorResponse(parsed.issues);
    }

    const { sinceRevision } = parsed.value;

    // Compaction drops history that is already folded into the snapshot. A
    // client asking for a revision below the window cannot be served
    // incrementally, so it is told to re-bootstrap instead of being handed a
    // partial operation set that would leave its vault silently inconsistent.
    if (sinceRevision < data.log.baseRevision) {
      return json(
        {
          error: 'HISTORY_TRUNCATED',
          message:
            'requested revision is older than the retained history; re-bootstrap from the snapshot',
          details: { baseRevision: data.log.baseRevision, revision: data.snapshot.revision },
        },
        410
      );
    }

    const operations = data.log.operations.filter(
      (op) => op.revision >= sinceRevision
    );
    return json({
      revision: data.snapshot.revision,
      operations,
    });
  }

  private async handleAssetUpload(
    request: Request,
    data: StoredVault
  ): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/');
    const assetId = parts[2];
    if (!assetId) {
      return json({ error: 'BAD_REQUEST', message: 'missing assetId' }, 400);
    }
    const body = await request.arrayBuffer();
    const size = body.byteLength;
    // Simple hash for verification – SHA-256 hex
    const hashBuffer = await crypto.subtle.digest('SHA-256', body);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    const mimeType =
      request.headers.get('content-type') ?? 'application/octet-stream';
    // Duplicate detection by hash
    const existingId = Object.entries(data.assets).find(
      ([, meta]) => meta.hash === hash
    )?.[0];
    if (existingId && existingId !== assetId) {
      // Duplicate asset already stored, reuse metadata
      return json({ assetId: existingId, hash, size, duplicate: true });
    }
    await this.state.storage.put(`asset:${assetId}`, body);
    data.assets[assetId] = { hash, size, mimeType, uploadedAt: Date.now() };
    await this.save(data);
    return json({ assetId, hash, size });
  }

  private async handleAssetDownload(
    request: Request,
    data: StoredVault
  ): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/');
    const assetId = parts[2];
    if (!assetId) {
      return json({ error: 'BAD_REQUEST', message: 'missing assetId' }, 400);
    }
    const meta = data.assets[assetId];
    if (!meta) {
      return json({ error: 'NOT_FOUND' }, 404);
    }
    const buf = await this.state.storage.get<ArrayBuffer>(`asset:${assetId}`);
    if (!buf) {
      return json({ error: 'NOT_FOUND' }, 404);
    }
    return new Response(buf, {
      headers: { 'Content-Type': meta.mimeType ?? 'application/octet-stream' },
    });
  }

  private async handleWsTicket(
    request: Request,
    data: StoredVault
  ): Promise<Response> {
    const body = await request.json().catch(() => null);
    const parsed = wsTicketRequestSchema(body);
    if (!parsed.ok) {
      return validationErrorResponse(parsed.issues);
    }
    const { deviceId, apiKey } = parsed.value;
    const device = data.metadata.devices[deviceId];
    if (!device) {
      return json({ error: 'UNAUTHORIZED', message: 'device not found' }, 401);
    }
    const hash = await this.hash(apiKey);
    if (hash !== device.apiKeyHash) {
      return json({ error: 'UNAUTHORIZED', message: 'invalid api key' }, 401);
    }
    // Prune expired tickets to avoid unbounded growth
    const list = await this.state.storage.list({ prefix: 'ws-ticket:' });
    const now = Date.now();
    for (const [key, value] of list.entries()) {
      const entry = value as { expiresAt: number };
      if (entry.expiresAt < now) {
        await this.state.storage.delete(key);
      }
    }
    const ticket = crypto.randomUUID();
    const expiresAt = Date.now() + 60_000;
    await this.state.storage.put(`ws-ticket:${ticket}`, {
      deviceId,
      expiresAt,
    });
    return json({ ticket, expiresAt }, 201);
  }

  private async broadcastVaultChanged(
    revision: number,
    pushingDeviceId?: string
  ): Promise<void> {
    try {
      const message = JSON.stringify({ type: 'vault-changed', revision });
      const allSockets = (this.state as any).getWebSockets?.() ?? [];
      const senderSockets = pushingDeviceId
        ? new Set((this.state as any).getWebSockets?.(pushingDeviceId) ?? [])
        : new Set();
      for (const ws of allSockets) {
        if (senderSockets.has(ws)) {
          continue;
        }
        try {
          ws.send(message);
        } catch {
          // ignore closed sockets
        }
      }
    } catch {
      // ignore broadcast errors
    }
  }

  private async handleWsUpgrade(
    request: Request,
    _data: StoredVault
  ): Promise<Response> {
    const url = new URL(request.url);
    const deviceId = url.searchParams.get('deviceId') ?? '';
    const ticket = url.searchParams.get('ticket') ?? '';
    if (!deviceId || !ticket) {
      return json(
        { error: 'BAD_REQUEST', message: 'missing ticket or deviceId' },
        400
      );
    }
    const stored = await this.state.storage.get<{
      deviceId: string;
      expiresAt: number;
    }>(`ws-ticket:${ticket}`);
    if (
      !stored ||
      stored.deviceId !== deviceId ||
      stored.expiresAt < Date.now()
    ) {
      return json(
        { error: 'UNAUTHORIZED', message: 'invalid or expired ticket' },
        401
      );
    }
    // single-use
    await this.state.storage.delete(`ws-ticket:${ticket}`);
    // Upgrade to WebSocket via hibernation API
    const pair = new (globalThis as any).WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    // Tag socket with device id for future filtering/broadcast
    (this.state as any).acceptWebSocket(server, [deviceId]);
    // Track connection for lifecycle & idle timeout
    this.connections.set(server, { deviceId, lastActive: Date.now() });
    // Schedule idle check alarm
    await this.state.storage.put('lastAlarm', Date.now());
    await this.state.storage.setAlarm(Date.now() + this.ALARM_INTERVAL_MS);
    // Optional auto-response for ping/pong without waking the DO
    (this.state as any).setWebSocketAutoResponse?.({
      request: '{"type":"ping"}',
      response: '{"type":"pong"}',
    });
    return new Response(null, { status: 101, webSocket: client } as any);
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    const entry = this.connections.get(ws);
    if (entry) {
      entry.lastActive = Date.now();
    }
    try {
      const text =
        typeof message === 'string'
          ? message
          : new TextDecoder().decode(message);
      const parsed = JSON.parse(text);
      const validated = realtimeClientMessageSchema(parsed);
      if (!validated.ok) {
        // Invalid client message — close the connection
        try {
          ws.close(1008, 'invalid message');
        } catch {}
        return;
      }
      // ping is auto-responded via setWebSocketAutoResponse; no further action needed
    } catch {
      try {
        ws.close(1008, 'invalid message');
      } catch {}
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    this.connections.delete(ws);
  }

  /**
   * Reads the persisted vault, migrating older shapes forward.
   *
   * Integrity handling is deliberately conservative: the snapshot is
   * authoritative and is only ever rebuilt from a log that still holds
   * complete history. A compacted log is a window, so a revision mismatch
   * against it is expected rather than a symptom, and replaying it would
   * silently truncate the vault to the operations that survived
   * compaction.
   */
  private async load(): Promise<StoredVault> {
    const stored = await this.state.storage.get<StoredVault>('vault');
    if (stored) {
      // Migrate logs written before the window offset was tracked.
      if (stored.log.baseRevision === undefined) {
        stored.log.baseRevision = 0;
      }
      // Migrate old snapshots without assets field
      if (!stored.snapshot.assets) {
        (stored.snapshot as VaultState).assets = {};
      }
      if (!stored.assets) {
        stored.assets = {};
      }
      if (this.isSnapshotBehindLog(stored)) {
        const { snapshotFromLog } = await import('@thoth/operations');
        const recovered = snapshotFromLog(stored.log);
        if (recovered.ok) {
          stored.snapshot = recovered.state;
          await this.state.storage.put('vault', stored);
        }
      }
      return stored;
    }
    return {
      metadata: { id: 'unknown', devices: {} },
      log: createOperationLog(),
      snapshot: createVaultState(),
      assets: {},
    };
  }

  /**
   * True when the log proves the snapshot is stale: the log's window ends
   * past the snapshot's revision, so operations were acknowledged without
   * being folded into the snapshot.
   *
   * A window that ends at or below the snapshot revision is normal after
   * compaction and is not treated as corruption.
   */
  private isSnapshotBehindLog(data: StoredVault): boolean {
    return logEndRevision(data.log) > data.snapshot.revision;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    // Idle timeout handling
    for (const [ws, meta] of this.connections.entries()) {
      if (now - meta.lastActive > this.IDLE_TIMEOUT_MS) {
        try {
          ws.close(1000, 'idle timeout');
        } catch {
          // Socket already closed; the map entry is dropped below either way.
        }
        this.connections.delete(ws);
      }
    }
    // Automatic snapshot verification
    await this.verifySnapshotIntegrity();
    await this.state.storage.setAlarm(now + this.ALARM_INTERVAL_MS);
  }

  /**
   * Truncates the log to the newest `LOG_WINDOW_SIZE` operations.
   *
   * The snapshot already reflects every applied operation, so compaction
   * only needs to keep enough recent history for lagging clients to catch
   * up incrementally. The retained window starts at
   * `snapshotRevision - retained.length`, which keeps revisions contiguous
   * and lets `pull` detect — via `log.baseRevision` — that a client has
   * fallen behind the window and must re-bootstrap from the snapshot.
   */
  private compactLog(log: OperationLog, snapshotRevision: number): OperationLog {
    const retained = log.operations.slice(-this.LOG_WINDOW_SIZE);
    return createLogWindow(snapshotRevision - retained.length, retained);
  }

  /**
   * Verifies that the snapshot covers everything the log records, and
   * reports a mismatch through the audit log.
   *
   * This never rewrites the snapshot: recovery happens on read in `load`,
   * and only for logs that still hold complete history.
   */
  private async verifySnapshotIntegrity(): Promise<void> {
    const data = await this.load();
    const { snapshot, log } = data;
    if (!this.isSnapshotBehindLog(data)) {
      return;
    }
    await this.audit('integrity-warning', {
      snapshotRevision: snapshot.revision,
      logEndRevision: logEndRevision(log),
      logBaseRevision: log.baseRevision,
      recoverable: isCompleteLog(log),
    });
  }

  private async save(data: StoredVault): Promise<void> {
    await this.state.storage.put('vault', data);
  }

  private async audit(
    action: string,
    details: Record<string, unknown>
  ): Promise<void> {
    const entry = { ts: Date.now(), action, details };
    const key = 'audit';
    const logs = (await this.state.storage.get<Array<typeof entry>>(key)) ?? [];
    logs.push(entry);
    // keep last 100 entries
    if (logs.length > 100) logs.splice(0, logs.length - 100);
    await this.state.storage.put(key, logs);
  }

  private async hash(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
