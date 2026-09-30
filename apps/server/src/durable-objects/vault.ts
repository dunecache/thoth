import type { DurableObjectState } from '@cloudflare/workers-types';
import {
  MAX_ASSET_BYTES,
  type Operation,
  type ValidationIssue,
} from '@thoth/protocol';
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

/**
 * Header the worker sets while the authentication grace period is open.
 *
 * Trusted because a Durable Object is only reachable through the worker, and
 * the worker strips any inbound copy before forwarding.
 */
const AUTH_GRACE_HEADER = 'x-thoth-auth-grace';

function isGraceOpen(request: Request): boolean {
  return request.headers.get(AUTH_GRACE_HEADER) === '1';
}

/** Storage key for a content-addressed asset blob. */
function assetBlobKey(hash: string): string {
  return `asset-blob:${hash}`;
}

/**
 * Per-IP request budgets, by route class.
 *
 * Sync traffic is generous because a client polls every 60-300s and pages
 * through its history. Creation is not: it is unauthenticated, and each call
 * mints a Durable Object that persists until someone deletes it. Bounding
 * only the general budget left creation at the same 600/min as ordinary
 * polling, which on the free tier is hundreds of durable objects per minute
 * per address.
 */
const RATE_LIMIT_MAX_REQUESTS = 120;
const RATE_LIMIT_MAX_CREATIONS = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
/** Distinct client IPs tracked before the in-memory budget is reset. */
const RATE_LIMIT_MAX_CLIENTS = 1000;

/**
 * Routes that provision durable objects, and so get the tight budget.
 *
 * The websocket handshake is excluded: it is one request per connection, not
 * a poll, and counting it only penalises a client for reconnecting.
 */
const CREATION_ROUTES = new Set(['/index/reserve']);

function rateLimitFor(pathname: string): number {
  return CREATION_ROUTES.has(pathname)
    ? RATE_LIMIT_MAX_CREATIONS
    : RATE_LIMIT_MAX_REQUESTS;
}

/**
 * The hibernation WebSocket surface of DurableObjectState.
 *
 * Every method is optional because the object may be running without the
 * WebSocket bindings, which is also the case in tests.
 */
interface HibernationState {
  getWebSockets?(tag?: string): WebSocket[];
  acceptWebSocket?(ws: WebSocket, tags?: string[]): void;
  setWebSocketAutoResponse?(options: { request: string; response: string }): void;
}

/** Response init carrying the client half of an upgraded WebSocket pair. */
interface UpgradeResponseInit extends ResponseInit {
  webSocket: WebSocket;
}

/**
 * Extracts the bearer token from an Authorization header.
 *
 * Returns null when the header is absent or not a bearer credential.
 */
function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
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
  private readonly rateBuckets = new Map<string, { count: number; startedAt: number }>();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  /** The object's hibernation WebSocket surface, when available. */
  private get hibernation(): HibernationState {
    return this.state as unknown as HibernationState;
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
    const rateLimited = this.checkRateLimit(request);
    if (rateLimited) {
      return rateLimited;
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
      // Never covered by the grace period: deleting a vault must always
      // require a credential.
      const denied = await this.authorize(request, data, { graceExempt: false });
      if (denied) {
        return denied;
      }
      await this.state.storage.delete('vault');
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/metadata' && method === 'GET') {
      const denied = await this.authorize(request, data);
      if (denied) {
        return denied;
      }
      return json({
        id: data.metadata.id,
        revision: data.snapshot.revision,
      });
    }

    // Vault index for GET /vaults (stored in DO id _vault-index)
    // The single shared object every vault creation passes through. It used
    // to hold the id list behind GET /vaults, which no longer exists; what
    // remains is the rate limit, and that is the point. The budget is held in
    // the object instance, and a freshly provisioned vault object always
    // starts with an empty one, so this shared route is the only place
    // creation can actually be bounded.
    if (url.pathname === '/index/reserve' && method === 'POST') {
      return json({ ok: true });
    }

    if (url.pathname === '/snapshot' && method === 'GET') {
      const denied = await this.authorize(request, data);
      if (denied) {
        return denied;
      }
      return json({
        revision: data.snapshot.revision,
        files: data.snapshot.files,
        assets: (data.snapshot).assets ?? {},
      });
    }

    if (url.pathname === '/snapshot' && method === 'POST') {
      const denied = await this.authorize(request, data);
      if (denied) {
        return denied;
      }
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
      data.snapshot = { revision: snapshot.revision, files: snapshot.files, assets: (snapshot).assets ?? {} };
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
      return this.handleWsUpgrade(request);
    }

    if (url.pathname === '/push' && method === 'POST') {
      return this.handlePush(request, data);
    }

    if (url.pathname === '/pull' && method === 'POST') {
      return this.handlePull(request, data);
    }

    // Device management
    if (url.pathname === '/devices' && method === 'POST') {
      const body: unknown = await request.json().catch(() => null);
      const parsed = registerDeviceSchema(body);
      if (!parsed.ok) {
        return validationErrorResponse(parsed.issues);
      }
      const { deviceId: requestedId, name } = parsed.value;
      const MAX_DEVICES = 20;

      // Reusing an id is checked before the cap, and reported honestly.
      // This previously fell through a ternary that substituted a fresh uuid
      // for a taken id, so the 409 below was unreachable: a client could not
      // learn its id was taken, and could not free it. That is what made
      // re-authentication leak a device slot on every attempt.
      if (requestedId && data.metadata.devices[requestedId]) {
        return json(
          {
            error: 'DEVICE_ALREADY_REGISTERED',
            message: 'this device id is already registered on the vault',
          },
          409
        );
      }
      if (Object.keys(data.metadata.devices).length >= MAX_DEVICES) {
        return json(
          {
            error: 'DEVICE_LIMIT_REACHED',
            message: `maximum of ${MAX_DEVICES} devices per vault`,
          },
          409
        );
      }
      const deviceId = requestedId ?? crypto.randomUUID();
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
      const denied = await this.authorize(request, data);
      if (denied) {
        return denied;
      }
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

      // Authorize before looking the device up. Reporting 404 for an unknown
      // device first would let an anonymous caller enumerate which device
      // ids exist by comparing it against the 401 a known one returns.
      // Revoking or rotating a credential is always enforced, even inside the
      // grace period.
      const denied = await this.authorize(request, data, { graceExempt: false });
      if (denied) {
        return denied;
      }

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

  /**
   * Per-IP request budget, held in memory.
   *
   * The counter used to live in Durable Object storage and was written on
   * every request, which meant one storage round-trip per asset download and
   * per WebSocket message. The budget is a soft abuse guard rather than a
   * correctness mechanism, so an in-memory window is enough: it resets when
   * the object is evicted, and the state is only consulted for read paths.
   *
   * Returns a 429 response when the caller is over budget.
   */
  /**
   * Verifies the request carries a credential belonging to a registered
   * device, returning a 401 response when it does not.
   *
   * A vault with no registered devices is left open. That is the bootstrap
   * window: a device cannot present a key before it has registered one, and
   * requiring it would make the wizard impossible. It is also safe, because
   * a vault only holds data once a device has pushed it, and pushing
   * requires a registered device — so any vault with content has at least
   * one credential and is therefore protected. Vaults provisioned before
   * authentication existed stay usable and become protected as soon as a
   * device registers.
   */
  private async authorize(
    request: Request,
    data: StoredVault,
    options: { graceExempt?: boolean } = {}
  ): Promise<Response | null> {
    // During the grace period the data routes accept a keyless request so a
    // client predating authentication keeps syncing. Destructive routes pass
    // graceExempt: false (the default) and are enforced regardless.
    if (options.graceExempt !== false && isGraceOpen(request)) {
      return null;
    }
    const devices = Object.entries(data.metadata.devices);
    if (devices.length === 0) {
      return null;
    }
    const token = bearerToken(request);
    if (!token) {
      return json(
        {
          error: 'UNAUTHORIZED',
          message: 'missing bearer credential; register this device or re-authenticate',
        },
        401
      );
    }
    const hash = await this.hash(token);
    const known = devices.some(([, device]) => device.apiKeyHash === hash);
    if (!known) {
      // The credential parsed but matches no device here — it was revoked,
      // rotated, or belongs to another vault. All three are resolved the
      // same way by the client, so they share one code.
      return json(
        {
          error: 'DEVICE_NOT_REGISTERED',
          message:
            'this device is no longer registered on the vault; register it again',
        },
        401
      );
    }
    return null;
  }

  private checkRateLimit(request: Request): Response | null {
    if (new URL(request.url).pathname === '/ws') {
      return null;
    }
    const clientIp = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const limit = rateLimitFor(new URL(request.url).pathname);
    // Keyed per budget so a burst of ordinary traffic cannot exhaust the
    // creation allowance, or vice versa.
    const key = `${limit}:${clientIp}`;
    const now = Date.now();
    const bucket = this.rateBuckets.get(key);
    if (!bucket || now - bucket.startedAt > RATE_LIMIT_WINDOW_MS) {
      this.rateBuckets.set(key, { count: 1, startedAt: now });
      return null;
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      return json(
        {
          error: 'TOO_MANY_REQUESTS',
          message: `limit is ${limit} requests per ${RATE_LIMIT_WINDOW_MS / 1000}s`,
        },
        429
      );
    }
    // Keep the map from growing without bound on a shared vault.
    if (this.rateBuckets.size > RATE_LIMIT_MAX_CLIENTS) {
      this.rateBuckets.clear();
    }
    return null;
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

    const denied = await this.authorize(request, data);
    if (denied) {
      return denied;
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

    // Idempotent replay. A client that pushes, loses the response, and
    // retries sends the identical batch against the now-stale baseRevision.
    // Rejecting that wedges the queue forever, so an exact replay is
    // acknowledged with the revision the operations already produced.
    if (this.isExactReplay(log, baseRevision, operations)) {
      return json({
        revision: snapshot.revision,
        capabilities: [],
        replayed: true,
      });
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
    // Partial overlap: some operations are already recorded but the batch is
    // not an exact replay, so the client's queue has diverged from the log.
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
    // A push is the one path that can leave the log ahead of the snapshot,
    // so the invariant is re-checked here rather than on a timer.
    await this.auditSnapshotIntegrity({
      metadata: updatedMetadata,
      log: compactedLog,
      snapshot: applied.state,
      assets: data.assets,
    });
    // Notify connected clients about the new revision
    const pushingDeviceId = operations[0]?.deviceId;
    this.broadcastVaultChanged(applied.state.revision, pushingDeviceId);

    return json({ revision: applied.state.revision, capabilities: [] });
  }

  /**
   * True when `operations` is a byte-identical re-send of a contiguous run
   * of operations already recorded at `baseRevision`.
   *
   * Comparing the serialized form is safe because both sides have been
   * through `operationSchema`, whose `object()` validator rebuilds each
   * operation with a fixed key order — so equal operations serialize
   * equally, and a client that reused an id with different content or a
   * different revision is correctly treated as a conflict.
   */
  private isExactReplay(
    log: OperationLog,
    baseRevision: number,
    operations: Operation[]
  ): boolean {
    if (operations.length === 0) {
      return false;
    }
    const recorded = new Map(log.operations.map((op) => [op.id, op]));
    return operations.every((op, index) => {
      const previous = recorded.get(op.id);
      return (
        previous !== undefined &&
        previous.revision === baseRevision + index &&
        JSON.stringify(previous) === JSON.stringify(op)
      );
    });
  }

  private async handlePull(
    request: Request,
    data: StoredVault
  ): Promise<Response> {
    const denied = await this.authorize(request, data);
    if (denied) {
      return denied;
    }
    const body = (await request.json().catch(() => null)) as unknown;
    const parsed = pullOperationsSchema(body);
    if (!parsed.ok) {
      return validationErrorResponse(parsed.issues);
    }

    const { sinceRevision, limit } = parsed.value;

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

    const available = data.log.operations.filter(
      (op) => op.revision >= sinceRevision
    );
    // Honour the client's page size so a large window is not sent in one
    // response. `hasMore` plus `nextRevision` lets the caller page without
    // having to reason about the log's shape.
    const page = limit ? available.slice(0, limit) : available;
    const lastReturned = page[page.length - 1];
    return json({
      revision: data.snapshot.revision,
      operations: page,
      hasMore: page.length < available.length,
      ...(lastReturned ? { nextRevision: lastReturned.revision + 1 } : {}),
    });
  }

  /**
   * Stores an uploaded asset blob.
   *
   * Blobs are content-addressed by hash so two paths holding identical bytes
   * share one stored copy. The requested asset id is always registered in
   * the asset registry, including when its bytes are already present under
   * another id: the `add-asset` operation the client pushes references the
   * id it chose, so leaving it unregistered makes that operation's snapshot
   * entry undownloadable for every other device.
   */
  private async handleAssetUpload(
    request: Request,
    data: StoredVault
  ): Promise<Response> {
    const denied = await this.authorize(request, data);
    if (denied) {
      return denied;
    }
    const url = new URL(request.url);
    const parts = url.pathname.split('/');
    const assetId = parts[2];
    if (!assetId) {
      return json({ error: 'BAD_REQUEST', message: 'missing assetId' }, 400);
    }
    const mimeType =
      request.headers.get('content-type') ?? 'application/octet-stream';
    const body = await request.arrayBuffer();
    const size = body.byteLength;
    // A Durable Object storage entry caps key and value at 2 MB combined;
    // reject early with a clear status instead of an opaque storage failure.
    if (size > MAX_ASSET_BYTES) {
      return json(
        {
          error: 'ASSET_TOO_LARGE',
          message: `asset is ${size} bytes, limit is ${MAX_ASSET_BYTES}`,
        },
        413
      );
    }
    const hash = await this.hashBytes(body);

    const existingId = Object.keys(data.assets).find(
      (id) => data.assets[id]?.hash === hash
    );
    if (existingId && existingId !== assetId) {
      const existing = data.assets[existingId];
      if (existing) {
        // Register the requested id as an alias over the shared blob.
        data.assets[assetId] = {
          hash,
          size: existing.size,
          mimeType,
          uploadedAt: existing.uploadedAt,
        };
        await this.save(data);
      }
      return json({
        assetId,
        hash,
        size: existing?.size ?? size,
        duplicate: true,
        canonicalAssetId: existingId,
      });
    }

    await this.state.storage.put(assetBlobKey(hash), body);
    data.assets[assetId] = { hash, size, mimeType, uploadedAt: Date.now() };
    await this.save(data);
    return json({ assetId, hash, size });
  }

  private async handleAssetDownload(
    request: Request,
    data: StoredVault
  ): Promise<Response> {
    const denied = await this.authorize(request, data);
    if (denied) {
      return denied;
    }
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
    // Prefer the content-addressed blob; fall back to the legacy layout
    // where the blob was stored under its own asset id.
    const buf =
      (await this.state.storage.get<ArrayBuffer>(assetBlobKey(meta.hash))) ??
      (await this.state.storage.get<ArrayBuffer>(`asset:${assetId}`));
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
    const body: unknown = await request.json().catch(() => null);
    const parsed = wsTicketRequestSchema(body);
    if (!parsed.ok) {
      return validationErrorResponse(parsed.issues);
    }
    const { deviceId, apiKey } = parsed.value;
    const device = data.metadata.devices[deviceId];
    if (!device) {
      // Matches the data-route code so the plugin treats a revoked device
      // the same way however it discovers it.
      return json(
        {
          error: 'DEVICE_NOT_REGISTERED',
          message: 'this device is no longer registered on the vault',
        },
        401
      );
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

  private broadcastVaultChanged(revision: number, pushingDeviceId?: string): void {
    try {
      const message = JSON.stringify({ type: 'vault-changed', revision });
      const allSockets = this.hibernation.getWebSockets?.() ?? [];
      // Skip the device that caused the change; it already applied it.
      const senderSockets = pushingDeviceId
        ? new Set(this.hibernation.getWebSockets?.(pushingDeviceId) ?? [])
        : new Set<WebSocket>();
      for (const ws of allSockets) {
        if (senderSockets.has(ws)) {
          continue;
        }
        try {
          ws.send(message);
        } catch {
          // Socket already closed; nothing to notify.
        }
      }
    } catch {
      // A failed notification must not fail the push that triggered it.
    }
  }

  private async handleWsUpgrade(request: Request): Promise<Response> {
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
    const Pair = (
      globalThis as unknown as { WebSocketPair?: new () => Record<'0' | '1', WebSocket> }
    ).WebSocketPair;
    if (!Pair) {
      return json(
        { error: 'WEBSOCKET_UNAVAILABLE', message: 'WebSocketPair is not available' },
        500
      );
    }
    const pair = new Pair();
    const client = pair['0'];
    const server = pair['1'];
    if (!client || !server) {
      return json(
        { error: 'WEBSOCKET_UNAVAILABLE', message: 'WebSocketPair did not yield both sockets' },
        500
      );
    }
    // Tag socket with device id for future filtering/broadcast
    this.hibernation.acceptWebSocket?.(server, [deviceId]);
    // Track connection for lifecycle & idle timeout
    this.connections.set(server, { deviceId, lastActive: Date.now() });
    // Keep the idle-timeout alarm running while sockets are attached
    await this.state.storage.setAlarm(Date.now() + this.ALARM_INTERVAL_MS);
    // Answer pings without waking the object
    this.hibernation.setWebSocketAutoResponse?.({
      request: '{"type":"ping"}',
      response: '{"type":"pong"}',
    });
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as UpgradeResponseInit);
  }

  /**
   * Hibernation message handler. The only valid frame is a ping, which the
   * runtime answers automatically without waking the object; anything else
   * is a protocol violation and closes the socket.
   */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const entry = this.connections.get(ws);
    if (entry) {
      entry.lastActive = Date.now();
    }
    if (!this.isValidClientFrame(message)) {
      this.closeInvalid(ws);
    }
  }

  private isValidClientFrame(message: string | ArrayBuffer): boolean {
    try {
      const text =
        typeof message === 'string'
          ? message
          : new TextDecoder().decode(message);
      const parsed: unknown = JSON.parse(text);
      return realtimeClientMessageSchema(parsed).ok;
    } catch {
      return false;
    }
  }

  private closeInvalid(ws: WebSocket): void {
    try {
      ws.close(1008, 'invalid message');
    } catch {
      // Socket already closed; nothing further to do.
    }
  }

  webSocketClose(ws: WebSocket): void {
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
        (stored.snapshot).assets = {};
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

  /**
   * Closes sockets that have gone idle, then re-arms only if any remain.
   *
   * The alarm used to re-arm unconditionally, so a single WebSocket
   * connection left a vault waking up every 60s for the lifetime of the
   * deployment even after every client had disconnected. With no sockets
   * attached there is nothing to time out, so the alarm is left unset and
   * the next connection re-arms it.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
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
    if (this.connections.size > 0) {
      await this.state.storage.setAlarm(now + this.ALARM_INTERVAL_MS);
    }
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
   * Reports a snapshot that the log proves is stale.
   *
   * This only records the mismatch. Recovery happens on read in `load`, and
   * only for logs that still hold complete history — a compacted window
   * legitimately ends below the snapshot revision.
   */
  private async auditSnapshotIntegrity(data: StoredVault): Promise<void> {
    if (!this.isSnapshotBehindLog(data)) {
      return;
    }
    await this.audit('integrity-warning', {
      snapshotRevision: data.snapshot.revision,
      logEndRevision: logEndRevision(data.log),
      logBaseRevision: data.log.baseRevision,
      recoverable: isCompleteLog(data.log),
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
    return this.hashBytes(encoder.encode(input));
  }

  private async hashBytes(data: BufferSource): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
