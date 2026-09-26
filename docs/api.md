# API Documentation

Base URL: `https://<worker>/`

## Health & Version

- `GET /health` → `{ status: "ok" }`
- `GET /version` → `{ version: string }`

## Vaults

- `POST /vaults` → create vault → `{ id, revision: 0 }`
- `GET /vaults/:id` → `{ id, revision }`
- `DELETE /vaults/:id` → 204

### Sync

- `POST /vaults/:id/push`
  Body: `{ baseRevision: number, operations: Operation[] }`
  Response: `{ revision: number }` or 409 Conflict
- `POST /vaults/:id/pull`
  Body: `{ sinceRevision: number }`
  Response: `{ revision: number, operations: Operation[] }`
- `GET /vaults/:id/snapshot`
  Response: `{ revision: number, files: Record<string,string> }`

### Devices

- `POST /vaults/:id/devices` → `{ deviceId, apiKey }`
- `GET /vaults/:id/devices` → `{ devices: [...] }`
- `DELETE /vaults/:id/devices/:deviceId` → 204
- `POST /vaults/:id/devices/:deviceId/rotate` → `{ deviceId, apiKey }`
- `POST /vaults/:id/devices/:deviceId/validate` → `{ valid: boolean }`

## Authentication

Requests that read or change vault data require the device credential:

```
Authorization: Bearer <apiKey>
```

`POST /vaults/:id/devices` is the exception — it issues the key. Every other
vault-scoped route is refused without one once the vault has at least one
registered device. A vault with no devices is open, because a device cannot
present a key before registering one; a vault only holds data once a device
has pushed it, so any vault with content is protected.

Revoked and rotated keys stop working immediately.

## Errors

Structured JSON:

```json
{
  "error": "VALIDATION_ERROR|REVISION_MISMATCH|CONFLICT|...",
  "message": "...",
  "details": {}
}
```

`error` is the stable, machine-readable identifier. Clients must branch on
it and never on `message`; see `ERROR_CODES` in `@thoth/protocol`.

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `BAD_REQUEST`, `VALIDATION_ERROR` | malformed request |
| 401 | `UNAUTHORIZED` | credential absent or malformed |
| 401 | `DEVICE_NOT_REGISTERED` | device was removed from the vault; re-register |
| 404 | `NOT_FOUND` | unknown route, vault, device or asset |
| 409 | `REVISION_MISMATCH`, `CONFLICT` | revision or duplicate-operation conflict |
| 410 | `HISTORY_TRUNCATED` | revision fell below retained history; re-bootstrap from the snapshot |
| 413 | `ASSET_TOO_LARGE` | blob exceeds the storage limit |
| 429 | `TOO_MANY_REQUESTS` | per-IP request budget exhausted |
| 500 | `INTERNAL_ERROR` | unexpected fault; correlate via `requestId` |

A 500 response carries a generic message only, so storage keys and vault ids
are not leaked to clients.
