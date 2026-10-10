# Protocol Documentation

Thoth synchronizes via atomic operations, not whole files.

## Core types

- `Operation` – immutable, ordered by `revision`
  - `id: string` – stable ULID/UUID
  - `type: 'create-note'|'delete-note'|'rename-note'|'replace-content'|'insert-text'|'delete-text'|'replace-range'|'add-asset'|'delete-asset'|'rename-folder'|'create-folder'|'delete-folder'`
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
- `create-folder` – `{ path }` — an explicitly created folder no file implies; ancestors are created by the receiver
- `delete-folder` – `{ path }` — removes a folder and the empty folders inside it; files are removed by the accompanying `delete-note`/`delete-asset`
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

## Folder state

A snapshot carries `folders: string[]` holding only folders that no file path
implies — the ones a user created and expects to still find there, empty. A
folder holding a note is derived from that note's path and is deliberately
absent, because storing every folder duplicates data that can disagree with
itself.

`create-folder`, `delete-folder` and `rename-folder` are advertised through the
`folders` capability. A client that has not seen it emits none of them, so
deployment order does not matter: an older server never receives an operation
it would reject, and a newer client against an older server degrades to the
per-file behaviour it already had.

## Auth Wizard

- `vaultId` via picker (`Create new vault` auto `uuid`, `Import thoth://?serverUrl&vaultId`), not manual `TextComponent`
- `deviceId` auto `uuidv4()`, `deviceName` defaults, `serverUrl` validated `https://` + `checkHealth` inline
