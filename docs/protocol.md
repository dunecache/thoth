# Protocol Documentation

Thoth synchronizes via atomic operations, not whole files.

## Core types

- `Operation` – immutable, ordered by `revision`
  - `id: string` – stable ULID/UUID
  - `type: 'create-note'|'delete-note'|'rename-note'|'replace-content'|'insert-text'|'delete-text'|'replace-range'|'add-asset'|'delete-asset'|'rename-folder'`
  - `deviceId: string`
  - `revision: number`
  - `parentRevision?: number`
  - `timestamp?: number`
  - `metadata?: Record<string,unknown>`
  - `payload` – type-specific

## Operation kinds

- `create-note` – `{ path, content }` — text files (md, txt, canvas, json); binary files use `add-asset` + base64 fallback via `files` map
- `replace-content` – `{ path, content }`
- `rename-note` – `{ oldPath, newPath }` — works for both text and binary, but only for files. A folder's own rename event is never emitted as this kind; see `rename-folder`
- `rename-folder` – `{ oldPath, newPath }` — moves a whole folder subtree (files, assets and nested paths) in one operation, and removes the original folder
- `delete-note` – `{ path }`
- `insert-text` – `{ path, index, text }`
- `delete-text` – `{ path, index, length }`
- `replace-range` – `{ path, index, length, text }`
- `add-asset` – `{ path, assetId, hash, size, mimeType? }` — binary files (png, jpg, pdf, etc.); blob uploaded via `PUT /vaults/:id/assets/:assetId` before push, downloaded via `GET` on apply
- `delete-asset` – `{ path, assetId }`

## Requests

- `PushOperationsRequest` – `{ baseRevision, operations[], protocolVersion?, requestId? }`
- `PullOperationsRequest` – `{ sinceRevision, protocolVersion?, limit?, continuationToken? }`

## Responses

- `PushOperationsResponse` – `{ revision, protocolVersion?, capabilities?, acknowledged? }`
- `PullOperationsResponse` – `{ revision, operations[], protocolVersion?, capabilities?, continuationToken?, hasMore? }`

## Validation

All requests validated with shared schemas in `@thoth/validation`.

- `operationSchema`
- `pushOperationsSchema`
- `pullOperationsSchema`
- `snapshotSchema`

## Invariants

- Revisions are monotonic and server-authoritative
- Operations are applied deterministically
- Log is append-only; snapshots are immutable
- Conflicts returned as 409 with current server revision

## Auth Wizard

- `vaultId` via picker (`Create new vault` auto `uuid`, `Import thoth://?serverUrl&vaultId`), not manual `TextComponent`
- `deviceId` auto `uuidv4()`, `deviceName` defaults, `serverUrl` validated `https://` + `checkHealth` inline
