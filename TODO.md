I would treat v0.2 as "Production Readiness". v0.1 proves the architecture; v0.2 makes it something you'd actually want to use every day.

---

Phase 1 — Protocol Evolution

Operation Model

[x] More granular text operations

[x] Stable operation IDs (UUID/ULID)

[x] Parent revision references

[x] Operation timestamps (informational only)

[x] Device attribution

[x] Optional operation metadata

Synchronization

[x] Operation batching

[x] Incremental acknowledgements

[x] Partial sync responses

[x] Better retry semantics

[x] Improved idempotency

Validation

[x] Protocol version negotiation

[x] Backward-compatible request parsing

[x] Protocol capability flags

---

Phase 2 — Real-Time Sync

Connections

[x] Durable Object WebSocket support

[x] Connection lifecycle management

[x] Heartbeats

[x] Automatic reconnection

[x] Idle timeout handling

Events

[x] Push new operations instantly

[x] Remote device notifications

[x] Immediate revision updates

[x] Live vault state

Client

[x] Automatic reconnect

[x] Offline detection

[x] Seamless transition between polling and real-time

---

Phase 3 — Attachment Synchronization

Asset Support

[x] Images

[x] PDFs

[x] Audio

[x] Videos

[x] Arbitrary files

Storage

[x] Asset metadata

[x] Upload protocol

[x] Download protocol

[x] Hash verification

[x] Duplicate detection

Synchronization

[x] Asset operations

[x] Missing asset detection

[x] Lazy downloads

[x] Background asset synchronization

---

Phase 4 — Snapshot Improvements

Snapshots

[x] Automatic snapshot intervals

[x] Snapshot compaction

[x] Snapshot pruning

[x] Snapshot verification

Recovery

[x] Restore from snapshot

[x] Verify snapshot integrity

[x] Snapshot migration

---

Phase 5 — Reliability

Recovery

[x] Crash recovery

[x] Interrupted upload recovery

[x] Interrupted download recovery

[x] Queue recovery

Integrity

[x] Operation checksum verification

[x] Snapshot checksum verification

[x] Corruption detection

[x] Revision verification

Diagnostics

[x] Sync health report

[x] Last successful sync

[x] Sync statistics

[x] Failure history

---

Phase 6 — Conflict Resolution

Detection

[x] Better concurrent edit detection

[x] Duplicate operation detection

[x] Replay protection

Resolution

[x] Improved automatic merges

[x] Better revision reconciliation

[x] Conflict reporting

[x] Retry optimization

Still not full CRDT.

---

Phase 7 — Plugin UX

Settings

[x] Connection diagnostics

[x] Test connection

[x] Device information

[x] Sync statistics

Commands

[x] Sync now

[x] Pause synchronization

[x] Resume synchronization

[x] Reset local cache

Status

[x] Status bar indicator

[x] Current sync state

[x] Queue size

[x] Last synchronization

[x] Active server

---

Phase 8 — Performance

Server

[x] Reduce Durable Object CPU usage

[x] Reduce storage writes

[x] Smarter serialization

[x] Faster replay

Plugin

[x] Incremental vault scanning

[x] Lower memory usage

[x] Reduced startup time

[x] Efficient operation queue

---

Phase 9 — Security

Authentication

[x] API key rotation

[x] Device revocation

[x] Session validation

Validation

[x] Request hardening

[x] Better input validation

[x] Abuse protection

Server

[x] Request size limits

[x] Operation count limits

[x] Rate limiting (lightweight)

---

Phase 10 — Developer Experience

Documentation

[x] Protocol specification

[x] Synchronization flow

[x] Architecture diagrams

[x] Deployment guide

Tooling

[x] Local development improvements

[x] Better logging

[x] Debug mode

[x] Replay operation logs

Testing

[x] Larger integration suite

[x] Multi-device tests

[x] Long-running sync tests

[x] Stress testing

[x] Performance benchmarks

---

Phase 11 — API Improvements

API

[x] Versioned endpoints

[x] Capability discovery

[x] Better error responses

[x] Consistent response models

Compatibility

[x] Graceful protocol upgrades

[x] Client version checks

---

Phase 12 — Production Polish

Stability

[x] Memory leak testing

[x] Worker restart testing

[x] Durable Object restart testing

Compatibility

[x] Latest Obsidian Desktop

[x] Android

[x] iOS

Release

[x] Migration documentation

[x] Upgrade path from v0.1

[x] Changelog

[x] Release validation

---

Nice-to-Have (Stretch Goals)

These aren't essential, but would be welcome additions if time allows:

Vault sync history and timeline

Per-device sync history

Sync activity log

Sync performance metrics

Optional debug panel

Asset deduplication by hash

Background attachment downloads

Smarter operation compaction

Snapshot export/import

Server maintenance commands

---

Deliberately Deferred to v0.3+

These are intentionally postponed because they significantly increase architectural complexity:

Multi-user shared vaults

User accounts

Role-based permissions

Live collaborative editing

CRDT implementation

End-to-end encryption

Web dashboard

Plugin marketplace integration

Search indexing

Comments and annotations

Presence indicators

Push notifications

AI-powered features

Cross-vault synchronization

Git interoperability

What v0.2 should feel like

The goal isn't to add the most features—it's to make Thoth feel invisible. Users shouldn't think about synchronization at all. They edit notes on one device, open another, and everything is already there. It should recover gracefully from network interruptions, efficiently handle larger vaults and attachments, provide enough diagnostics to troubleshoot issues, and continue to run comfortably within the Cloudflare free tier. At the end of v0.2, Thoth should feel like a dependable piece of infrastructure rather than an experimental sync engine.

---

Phase 13 — Auth UX (Minimal Input Wizard)

Goal: user enters only `Server URL`; `vaultId`/`deviceId`/`apiKey` are picker/auto.

Plugin `apps/obsidian-plugin/src`

[x] `settings.ts:1` add `lastVaultIds: string[]` + `asVaultIdList` + `parseSettings` migration
[x] `settings.ts` add `serverUrl` health cache type
[x] `api.ts` add `validateServerUrl` + `importVaultLink` parser for `thoth://?serverUrl&vaultId`
[x] `settings-tab.ts:21` replace `Vault ID` TextComponent with stepper S1 Server `[Text][Check]` → `checkHealth` `✓/✗`
[x] `settings-tab.ts` S2 Vault `[Dropdown recent][Create new vault][Import link/QR]` → `createVault:main.ts:301`
[x] `settings-tab.ts:42` S3 Device `[Text defaultDeviceName][Register]` → `registerDevice:212` auto `uuidv4`
[x] `main.ts:212` `registerDevice` no manual `deviceId` input, trim `deviceName` fallback
[x] `main.ts:191` `checkConnection` inline status, no Notice spam
[x] `main.ts:355` `updateStatusBar` `● live`/`○ polling`/`not configured` for wizard
[x] `main.ts:565` `bootstrapLocalVault` uses recent vaults picker

Server `apps/server/src` / `packages/protocol|validation`

[x] `validation/schemas.ts:34` add `serverUrlSchema` (`https://` pattern)
[x] `protocol/requests.ts` add `ImportVaultRequest` if link flow
[x] `durable-objects/vault.ts:187` keep `POST /devices`/`POST /vaults`, no new paid product

Tests & Docs

[x] `__tests__/settings.test.ts:10` `parseSettings` with `lastVaultIds`
[x] `__tests__/settings-tab.test.ts` wizard stepper (S1→S2→S3) — manual verify, no headless Obsidian UI test
[x] `docs/asset-migration.md` add wizard steps (1 field)
[x] `docs/protocol.md:6` note `vaultId` via picker, not manual
