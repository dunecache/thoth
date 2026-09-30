import { jsonHeaders, readHeaders } from './auth.js';

export type ConnectionResult =
  { ok: true; message: string } | { ok: false; message: string };

export type RegisterResult =
  | { ok: true; deviceId: string; apiKey: string }
  | {
      ok: false;
      message: string;
      /** The server's machine-readable code, when it sent one. */
      code?: string;
    };

export type RotateResult =
  | { ok: true; deviceId: string; apiKey: string }
  | { ok: false; message: string };

export type DeviceSummary = { id: string; createdAt: number; name?: string };

export type ListDevicesResult =
  | { ok: true; devices: DeviceSummary[] }
  | { ok: false; message: string; unauthorized?: boolean; error?: string };

export type DeleteDeviceResult = { ok: true } | { ok: false; message: string };

export type CreateVaultResult =
  { ok: true; vaultId: string } | { ok: false; message: string };

function baseUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateServerUrl(url: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, error: 'Server URL is required' };
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, error: 'URL must start with https:// or http://' };
    }
    return { ok: true, url: parsed.toString().replace(/\/+$/, '') };
  } catch {
    return { ok: false, error: 'Invalid URL format' };
  }
}

export type ImportVaultLink = { serverUrl: string; vaultId: string };

/**
 * Builds the invite link another device uses to join this vault.
 *
 * Defined beside `parseImportVaultLink` so the two cannot drift, and it
 * deliberately carries only the server URL and vault id. The API key is never
 * included: the joining device registers itself and receives its own
 * credential, so a link that granted access would turn any forwarded invite
 * into a permanent, unexpirable grant.
 *
 * Returns null when either half is missing, since a partial link would parse
 * as invalid on the other side and fail with a confusing message.
 */
export function buildInviteLink(
  serverUrl: string,
  vaultId: string
): string | null {
  const validated = validateServerUrl(serverUrl);
  const id = vaultId.trim();
  if (!validated.ok || !id) {
    return null;
  }
  const params = new URLSearchParams({
    serverUrl: validated.url,
    vaultId: id,
  });
  return `thoth://?${params.toString()}`;
}

export function parseImportVaultLink(link: string): ImportVaultLink | null {
  const trimmed = link.trim();
  if (!trimmed) return null;
  // thoth://?serverUrl=https://...&vaultId=...
  try {
    if (trimmed.startsWith('thoth://')) {
      const url = new URL(trimmed);
      const serverUrl = url.searchParams.get('serverUrl') ?? url.searchParams.get('server');
      const vaultId = url.searchParams.get('vaultId') ?? url.searchParams.get('vault');
      if (serverUrl && vaultId) {
        const validated = validateServerUrl(serverUrl);
        if (validated.ok) return { serverUrl: validated.url, vaultId: vaultId.trim() };
      }
    }
    // also accept https://...#vaultId=... or plain vaultId
    if (/^[a-zA-Z0-9_-]{8,}$/.test(trimmed) && !trimmed.includes('://')) {
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

/** Creates a vault on the server. */
export async function createVault(
  serverUrl: string
): Promise<CreateVaultResult> {
  try {
    const res = await fetch(`${baseUrl(serverUrl)}/vaults`, { method: 'POST' });
    if (!res.ok) {
      return {
        ok: false,
        message: `Create vault failed with status ${res.status}`,
      };
    }
    const body = (await res.json()) as { id: string };
    if (!body.id) {
      return { ok: false, message: 'Create vault response missing id' };
    }
    return { ok: true, vaultId: body.id };
  } catch (error) {
    return {
      ok: false,
      message: `Create vault failed: ${errorMessage(error)}`,
    };
  }
}

/** Pings the server health endpoint. */
export async function checkHealth(
  serverUrl: string
): Promise<ConnectionResult> {
  try {
    const res = await fetch(`${baseUrl(serverUrl)}/health`);
    if (!res.ok) {
      return {
        ok: false,
        message: `Health check failed with status ${res.status}`,
      };
    }
    const body = (await res.json()) as { status?: unknown };
    if (body.status !== 'ok') {
      return {
        ok: false,
        message: 'Health check returned an unexpected payload',
      };
    }
    return { ok: true, message: 'Server is reachable' };
  } catch (error) {
    return {
      ok: false,
      message: `Health check failed: ${errorMessage(error)}`,
    };
  }
}

/** Registers a device with the server. */
export async function registerDevice(params: {
  serverUrl: string;
  vaultId: string;
  deviceId: string;
  name: string;
}): Promise<RegisterResult> {
  try {
    const res = await fetch(
      `${baseUrl(params.serverUrl)}/vaults/${encodeURIComponent(params.vaultId)}/devices`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: params.deviceId, name: params.name }),
      }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      return {
        ok: false,
        message:
          body.message ?? `Registration failed with status ${res.status}`,
        // Carried so a caller can react to a specific cause rather than
        // matching on the human-readable text.
        ...(body.error ? { code: body.error } : {}),
      };
    }
    const body = (await res.json()) as { deviceId: string; apiKey: string };
    if (!body.deviceId || !body.apiKey) {
      return { ok: false, message: 'Registration response missing fields' };
    }
    return { ok: true, deviceId: body.deviceId, apiKey: body.apiKey };
  } catch (error) {
    return {
      ok: false,
      message: `Registration failed: ${errorMessage(error)}`,
    };
  }
}

/** Verifies the device API key against the server. */
export async function testAuthentication(params: {
  serverUrl: string;
  vaultId: string;
  deviceId: string;
  apiKey: string;
}): Promise<ConnectionResult> {
  try {
    const res = await fetch(
      `${baseUrl(params.serverUrl)}/vaults/${encodeURIComponent(params.vaultId)}/devices/${encodeURIComponent(params.deviceId)}/validate`,
      {
        method: 'POST',
        headers: jsonHeaders(params.apiKey),
        body: JSON.stringify({ apiKey: params.apiKey }),
      }
    );
    if (!res.ok) {
      return {
        ok: false,
        message: `Authentication request failed with status ${res.status}`,
      };
    }
    const body = (await res.json()) as { valid?: unknown };
    return body.valid === true
      ? { ok: true, message: 'Authentication succeeded' }
      : { ok: false, message: 'Authentication failed: invalid API key' };
  } catch (error) {
    return {
      ok: false,
      message: `Authentication failed: ${errorMessage(error)}`,
    };
  }
}

/** Lists devices registered to a vault. */
export async function listDevices(params: {
  serverUrl: string;
  vaultId: string;
  apiKey: string;
}): Promise<ListDevicesResult> {
  try {
    const res = await fetch(
      `${baseUrl(params.serverUrl)}/vaults/${encodeURIComponent(params.vaultId)}/devices`,
      { headers: readHeaders(params.apiKey) }
    );
    if (!res.ok) {
      return {
        ok: false,
        message: `List devices failed with status ${res.status}`,
        ...(res.status === 401 ? { unauthorized: true } : {}),
      };
    }
    const body = (await res.json()) as { devices: DeviceSummary[] };
    if (!Array.isArray(body.devices)) {
      return { ok: false, message: 'List devices response malformed' };
    }
    return { ok: true, devices: body.devices };
  } catch (error) {
    return {
      ok: false,
      message: `List devices failed: ${errorMessage(error)}`,
    };
  }
}

/** Removes a device from a vault. */
export async function removeDevice(params: {
  serverUrl: string;
  vaultId: string;
  apiKey: string;
  deviceId: string;
}): Promise<DeleteDeviceResult> {
  try {
    const res = await fetch(
      `${baseUrl(params.serverUrl)}/vaults/${encodeURIComponent(params.vaultId)}/devices/${encodeURIComponent(params.deviceId)}`,
      {
        method: 'DELETE',
        headers: readHeaders(params.apiKey),
      }
    );
    if (!res.ok && res.status !== 204) {
      return {
        ok: false,
        message: `Remove device failed with status ${res.status}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: `Remove device failed: ${errorMessage(error)}`,
    };
  }
}

/** Rotates a device API key. */
export async function rotateApiKey(params: {
  serverUrl: string;
  vaultId: string;
  apiKey: string;
  deviceId: string;
}): Promise<RotateResult> {
  try {
    const res = await fetch(
      `${baseUrl(params.serverUrl)}/vaults/${encodeURIComponent(params.vaultId)}/devices/${encodeURIComponent(params.deviceId)}/rotate`,
      {
        method: 'POST',
        headers: readHeaders(params.apiKey),
      }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      return {
        ok: false,
        message: body.message ?? `Rotate failed with status ${res.status}`,
      };
    }
    const body = (await res.json()) as { deviceId: string; apiKey: string };
    if (!body.deviceId || !body.apiKey) {
      return { ok: false, message: 'Rotate response missing fields' };
    }
    return { ok: true, deviceId: body.deviceId, apiKey: body.apiKey };
  } catch (error) {
    return { ok: false, message: `Rotate failed: ${errorMessage(error)}` };
  }
}
