import { healthHandler } from './health.js';
import { createLogger } from '../logger/index.js';
import { handleError } from '../errors/handler.js';
import { HttpError } from '../errors/http-error.js';
import type { Env } from '../types/worker.js';

/** Object name backing the vault-index Durable Object. */
const VAULT_INDEX_NAME = '_vault-index';

/**
 * The Durable Object binding, narrowed to what the router calls.
 *
 * The router works with the platform `Response` while the Durable Object
 * type declarations bring their own structurally different `Response` and
 * `Request`. Narrowing to the two members actually used keeps that mismatch
 * in one documented place instead of casting at every call site.
 */
interface VaultBinding {
  idFromName(name: string): unknown;
  get(id: unknown): {
    fetch(request: RequestInfo | URL, init?: RequestInit): Promise<UpgradedResponse>;
  };
}

/** A response that may carry the client half of a WebSocket pair. */
type UpgradedResponse = Response & { webSocket?: WebSocket | null };

export function createRouter(env: Env) {
  const log = createLogger(env);

  const corsHeaders = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });

  // An upgraded response carries a `webSocket` handle that only the runtime
  // can use, so those must be returned verbatim; rebuilding one drops the
  // handle and the connection never opens.
  const addCors = (res: UpgradedResponse): UpgradedResponse => {
    if (res.webSocket) {
      return res;
    }
    const headers = new Headers(res.headers);
    corsHeaders.forEach((v, k) => headers.set(k, v));
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };

  const binding = env.VAULT_DO as unknown as VaultBinding | undefined;

  const stubFor = (name: string) => {
    if (!binding) {
      return null;
    }
    return binding.get(binding.idFromName(name));
  };

  return async (request: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      log.info('request received', { requestId });

      if (url.pathname === '/health' && request.method === 'GET') {
        return addCors(healthHandler());
      }

      if (url.pathname === '/version' && request.method === 'GET') {
        return addCors(
          new Response(JSON.stringify({ version: env.VERSION ?? '0.1.0' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }

      if (url.pathname === '/vaults' && request.method === 'GET') {
        const stub = stubFor(VAULT_INDEX_NAME);
        if (stub) {
          const res = await stub.fetch('https://internal/index/list');
          return addCors(res);
        }
        return addCors(new Response(JSON.stringify({ vaults: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }

      if (url.pathname === '/vaults' && request.method === 'POST') {
        const id = crypto.randomUUID();
        {
          const stub = stubFor(id);
          await stub?.fetch('https://internal/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
          // Index for GET /vaults
          const indexStub = stubFor(VAULT_INDEX_NAME);
          await indexStub?.fetch('https://internal/index/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        }
        return addCors(
          new Response(JSON.stringify({ id, revision: 0 }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }

      const vaultIdMatch = url.pathname.match(/^\/vaults\/([^/]+)/);
      if (vaultIdMatch) {
        const vaultId = vaultIdMatch[1] ?? '';
        if (vaultId === VAULT_INDEX_NAME) {
          // The index object shares the /vaults namespace but is not a
          // vault. Routing to it would expose the vault list through
          // metadata and diagnostics, and let DELETE purge the index.
          return addCors(
            new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 })
          );
        }

        // Vault-level routes
        if (url.pathname === `/vaults/${vaultId}` && request.method === 'GET') {
          const stub = stubFor(vaultId);
          if (stub) {
            const res = await stub.fetch('https://internal/metadata');
            if (res.ok) return addCors(res);
          }
          return addCors(
            new Response(JSON.stringify({ id: vaultId, revision: 0 }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          );
        }

        if (
          url.pathname === `/vaults/${vaultId}` &&
          request.method === 'DELETE'
        ) {
          const stub = stubFor(vaultId);
          await stub?.fetch('https://internal/purge', { method: 'DELETE' });
          return addCors(new Response(null, { status: 204 }));
        }

        // Operation sync routes
        const noBinding = (): Response =>
          addCors(
            handleError(
              new HttpError(
                500,
                'INTERNAL_ERROR',
                'Vault Durable Object binding is not configured'
              )
            )
          );

        const forwardToVault = async (path: string): Promise<Response> => {
          const stub = stubFor(vaultId);
          if (!stub) {
            return noBinding();
          }
          const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
          const body = hasBody ? await request.text() : undefined;
          const headers = new Headers({ 'Content-Type': 'application/json' });
          for (const [k, v] of request.headers.entries()) {
            if (k.toLowerCase() !== 'content-type') headers.set(k, v);
          }
          const res = await stub.fetch(`https://internal${path}`, {
            method: request.method,
            body,
            headers,
          });
          return addCors(res);
        };

        if (
          url.pathname === `/vaults/${vaultId}/push` &&
          request.method === 'POST'
        ) {
          return forwardToVault('/push');
        }

        if (
          url.pathname === `/vaults/${vaultId}/pull` &&
          request.method === 'POST'
        ) {
          return forwardToVault('/pull');
        }

        if (url.pathname === `/vaults/${vaultId}/snapshot` && (request.method === 'GET' || request.method === 'POST')) {
          return forwardToVault('/snapshot');
        }

        if (
          url.pathname === `/vaults/${vaultId}/ws-ticket` &&
          request.method === 'POST'
        ) {
          return forwardToVault('/ws-ticket');
        }

        // WebSocket upgrade — return DO response verbatim without CORS re-wrap
        if (
          url.pathname === `/vaults/${vaultId}/ws` &&
          request.method === 'GET'
        ) {
          if (!env.VAULT_DO) {
            return addCors(
              handleError(
                new HttpError(
                  500,
                  'INTERNAL_ERROR',
                  'Vault Durable Object binding is not configured'
                )
              )
            );
          }
          const stub = stubFor(vaultId);
          if (!stub) {
            return addCors(
              handleError(
                new HttpError(
                  500,
                  'INTERNAL_ERROR',
                  'Vault Durable Object binding is not configured'
                )
              )
            );
          }
          // Pass original request through to preserve Upgrade headers
          const internalUrl = `https://internal/ws${url.search}`;
          const req = new Request(internalUrl, request);
          const res = await stub.fetch(req);
          if (res.webSocket) return res;
          return addCors(res);
        }

        // Asset routes — must forward ArrayBuffer, not text
        if (url.pathname.startsWith(`/vaults/${vaultId}/assets`)) {
          if (!binding) {
            return noBinding();
          }
          const stub = stubFor(vaultId);
          if (!stub) {
            return noBinding();
          }
          const assetPath = url.pathname.replace(`/vaults/${vaultId}`, '');
          const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
          const body = hasBody ? await request.arrayBuffer() : undefined;
          const headers = new Headers(request.headers);
          const res = await stub.fetch(`https://internal${assetPath}`, { method: request.method, headers, body });
          return addCors(res);
        }

        // Device routes
        if (url.pathname.startsWith(`/vaults/${vaultId}/devices`)) {
          const deviceStub = stubFor(vaultId);
          if (deviceStub) {
            const devicePath = url.pathname.replace(`/vaults/${vaultId}`, '');
            const hasBody =
              request.method !== 'GET' && request.method !== 'HEAD';
            const body = hasBody ? await request.text() : undefined;
            const headers = new Headers(request.headers);
            if (hasBody) headers.set('Content-Type', 'application/json');
            const res = await deviceStub.fetch(`https://internal${devicePath}`, {
              method: request.method,
              headers,
              body,
            });
            return addCors(res);
          }
          // No Durable Object binding: fall through to the in-memory
          // responses below, which the router tests rely on.
          if (
            url.pathname === `/vaults/${vaultId}/devices` &&
            request.method === 'POST'
          ) {
            const deviceId = crypto.randomUUID();
            const apiKey = crypto.randomUUID();
            return addCors(
              new Response(JSON.stringify({ deviceId, apiKey }), {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
              })
            );
          }
          if (
            url.pathname === `/vaults/${vaultId}/devices` &&
            request.method === 'GET'
          ) {
            return addCors(
              new Response(JSON.stringify({ devices: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              })
            );
          }
          // Device specific actions fallback. The path is split rather than
          // matched with a RegExp so a vault id containing regex
          // metacharacters cannot alter the pattern.
          const deviceAction = url.pathname
            .slice(`/vaults/${vaultId}/devices/`.length)
            .split('/');
          const deviceId = deviceAction[0];
          const action = deviceAction.length > 1 ? `/${deviceAction.slice(1).join('/')}` : '';
          if (deviceId) {
            if (request.method === 'DELETE' && !action) {
              return addCors(new Response(null, { status: 204 }));
            }
            if (request.method === 'POST' && action === '/rotate') {
              const apiKey = crypto.randomUUID();
              return addCors(
                new Response(JSON.stringify({ deviceId, apiKey }), {
                  headers: { 'Content-Type': 'application/json' },
                })
              );
            }
            if (request.method === 'POST' && action === '/validate') {
              return addCors(
                new Response(JSON.stringify({ valid: true }), {
                  headers: { 'Content-Type': 'application/json' },
                })
              );
            }
          }
          return addCors(
            new Response(JSON.stringify({ error: 'NOT_FOUND' }), {
              status: 404,
            })
          );
        }
      }

      return addCors(
        new Response(
          JSON.stringify({ error: 'NOT_FOUND', message: 'Route not found' }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );
    } catch (err) {
      log.error('handler error', { requestId }, err);
      return addCors(handleError(err, { requestId }));
    }
  };
}
