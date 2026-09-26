import { Notice, Plugin, TFile } from 'obsidian';

import type { Operation } from '@thoth/protocol';
import { snapshotSchema } from '@thoth/validation';

import {
  checkHealth,
  createVault,
  listDevices,
  registerDevice,
  removeDevice,
  rotateApiKey,
  testAuthentication,
} from './api.js';
import {
  loadPluginData,
  savePluginData,
  type Persistence,
} from './persistence.js';
import { OperationQueue } from './queue.js';
import { createApplyGuard } from './apply-guard.js';
import { planBootstrap, type LocalEntry } from './bootstrap-plan.js';
import { attachVaultListener } from './vault-listener.js';
import {
  DEFAULT_SETTINGS,
  type ThothSettings,
  pushRecentVaultId,
  withSetting,
} from './settings.js';
import { ThothSettingTab } from './settings-tab.js';
import { confirmAction } from './confirm-modal.js';
import { uuidv4 } from './uuid.js';
import {
  uploadOperations,
  acknowledgeOperations,
  downloadAndApply,
  downloadSnapshot,
  downloadOperations,
  uploadAsset,
  downloadAsset,
  type SnapshotAsset,
} from './sync-engine.js';
import { RetryScheduler } from './retry-scheduler.js';
import type { VaultAdapter } from './vault-applier.js';
import {
  applySnapshotToVault,
  applyOperationsToVault,
  assetIdForPath,
  hashArrayBuffer,
  isBinaryPath,
  MAX_ASSET_SIZE,
  mimeTypeForPath,
} from './vault-applier.js';
import { connectRealtime, type RealtimeStatus } from './realtime-client.js';

const AUTO_SYNC_DEBOUNCE_MS = 1_500;

// Obsidian loads the plugin entry module and instantiates its default
// export. The default export is the Obsidian plugin contract; the named
// export lets other modules import the type without the runtime cycle.
export class ThothPlugin extends Plugin {
  settings: ThothSettings = { ...DEFAULT_SETTINGS };
  readonly queue = new OperationQueue((queue) => this.saveQueue(queue));
  serverRevision = 0;
  deviceList: Array<{ id: string; createdAt: number; name?: string }> = [];
  /** Tracks the applier's own vault writes so they are not re-queued. */
  private readonly applyGuard = createApplyGuard();
  private detachVaultListener?: () => void;
  private scheduler?: RetryScheduler;
  private isSyncing = false;
  private isPaused = false;
  private statusBarEl?: HTMLElement;
  private realtimeClient?: { close(): void };
  private realtimeStatus: RealtimeStatus = 'closed';

  async onload(): Promise<void> {
    await this.loadPersisted();

    this.addSettingTab(new ThothSettingTab(this.app, this));

    this.addCommand({
      id: 'thoth-check-connection',
      name: 'Check Thoth connection',
      callback: () => {
        void this.checkConnection();
      },
    });

    this.addCommand({
      id: 'thoth-sync-now',
      name: 'Sync now',
      callback: () => {
        void this.manualSync();
      },
    });

    this.addCommand({
      id: 'thoth-pause-sync',
      name: 'Pause synchronization',
      callback: () => {
        this.pauseSync();
      },
    });

    this.addCommand({
      id: 'thoth-resume-sync',
      name: 'Resume synchronization',
      callback: () => {
        this.resumeSync();
      },
    });

    this.addCommand({
      id: 'thoth-reset-cache',
      name: 'Reset local cache',
      callback: () => {
        void this.resetLocalCache();
      },
    });

    this.addCommand({
      id: 'thoth-export-snapshot',
      name: 'Export snapshot (thoth-snapshot.json)',
      callback: () => {
        void this.exportSnapshot();
      },
    });

    this.addCommand({
      id: 'thoth-import-snapshot',
      name: 'Import snapshot (thoth-snapshot.json)',
      callback: () => {
        void this.importSnapshot();
      },
    });

    this.addCommand({
      id: 'thoth-rescan-vault',
      name: 'Rescan vault (re-queue missing files)',
      callback: () => {
        void this.rescanVault();
      },
    });

    this.scheduler = new RetryScheduler({
      task: () => this.performSync(),
      baseIntervalMs: 60_000,
      maxDelayMs: 600_000,
    });
    this.scheduler.start();

    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar();

    this.ensureRealtimeClient();

    // Sync on app foreground / visibility change
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void this.scheduler?.trigger();
      }
    });

    const attachListener = () => {
      this.detachVaultListener = attachVaultListener({
        vault: this.app.vault,
        queue: this.queue,
        getDeviceId: () => this.settings.deviceId,
        getExtensions: () => this.settings.syncedExtensions,
        isAppliedChange: (path, fingerprint) =>
          this.applyGuard.consume(path, fingerprint),
        onLocalChange: () => {
          if (
            this.settings.serverUrl &&
            this.settings.vaultId &&
            this.settings.deviceId &&
            this.settings.apiKey
          ) {
            this.scheduler?.scheduleSoon(AUTO_SYNC_DEBOUNCE_MS);
            this.updateStatusBar();
          }
        },
      });
    };
    if (this.app.workspace.layoutReady) {
      attachListener();
    } else {
      this.app.workspace.onLayoutReady(attachListener);
    }

    // Initial synchronization
    void this.performSync();
  }

  onunload(): void {
    if (this.detachVaultListener) {
      this.detachVaultListener();
      this.detachVaultListener = undefined;
    }
    if (this.scheduler) {
      this.scheduler.stop();
      this.scheduler = undefined;
    }
    this.realtimeClient?.close();
    this.realtimeClient = undefined;
  }

  /** Restores settings and the persisted operation queue on startup. */
  async loadPersisted(): Promise<void> {
    const data = await loadPluginData(this.storage());
    this.settings = data.settings;
    this.queue.replaceAll(data.queue);
    this.serverRevision = data.serverRevision;
  }

  /** Persists settings and the queue as one plugin data blob. */
  async saveSettings(): Promise<void> {
    await savePluginData(this.storage(), {
      settings: this.settings,
      queue: [...this.queue.all],
      serverRevision: this.serverRevision,
    });
    this.ensureRealtimeClient();
  }

  async saveQueue(queue: OperationQueue): Promise<void> {
    await savePluginData(this.storage(), {
      settings: this.settings,
      queue: [...queue.all],
      serverRevision: this.serverRevision,
    });
  }

  async checkConnection(): Promise<void> {
    if (!this.settings.serverUrl) {
      this.settings = withSetting(this.settings, 'lastHealthCheck', {
        url: '',
        ok: false,
        message: 'Configure a server URL first (wizard step 1)',
        at: Date.now(),
      });
      await this.saveSettings();
      this.updateStatusBar();
      new Notice('Thoth: configure a server URL first');
      return;
    }

    const health = await checkHealth(this.settings.serverUrl);
    this.settings = withSetting(this.settings, 'lastHealthCheck', {
      url: this.settings.serverUrl,
      ok: health.ok,
      message: health.message,
      at: Date.now(),
    });
    await this.saveSettings();
    this.updateStatusBar();
    if (!health.ok) {
      console.debug('Thoth: health check failed (inline status)', health.message);
      new Notice(`Thoth: ${health.message}`);
      return;
    }

    const auth = await testAuthentication({
      serverUrl: this.settings.serverUrl,
      vaultId: this.settings.vaultId,
      deviceId: this.settings.deviceId,
      apiKey: this.settings.apiKey,
    });
    // inline status for wizard/diagnostics, single Notice (no spam) — settings-tab reads lastHealthCheck
    this.settings = withSetting(this.settings, 'lastHealthCheck', {
      url: this.settings.serverUrl,
      ok: auth.ok,
      message: auth.message,
      at: Date.now(),
    });
    await this.saveSettings();
    this.updateStatusBar();
    console.debug('Thoth: checkConnection', auth.message);
    new Notice(`Thoth: ${auth.message}`);
  }

  async registerDevice(): Promise<void> {
    const { serverUrl, vaultId, deviceName } = this.settings;
    if (!serverUrl || !vaultId) {
      new Notice('Thoth: server URL and vault ID are required');
      return;
    }
    // no manual deviceId input — auto uuid, trim name with fallback (AGENTS: wizard S3)
    const name = deviceName.trim() || 'Obsidian Device';
    const deviceId = uuidv4();
    const res = await registerDevice({ serverUrl, vaultId, deviceId, name });
    if (!res.ok) {
      new Notice(`Thoth: registration failed – ${res.message}`);
      return;
    }
    this.settings = withSetting(this.settings, 'deviceId', res.deviceId);
    this.settings = withSetting(this.settings, 'apiKey', res.apiKey);
    this.settings = withSetting(this.settings, 'deviceName', name);
    await this.saveSettings();
    await this.refreshDeviceList();
    new Notice('Thoth: device registered');
  }

  async rotateApiKey(): Promise<void> {
    const { serverUrl, vaultId, deviceId } = this.settings;
    if (!serverUrl || !vaultId || !deviceId) {
      new Notice('Thoth: device not registered');
      return;
    }
    const res = await rotateApiKey({ serverUrl, vaultId, deviceId });
    if (!res.ok) {
      new Notice(`Thoth: rotate failed – ${res.message}`);
      return;
    }
    this.settings = withSetting(this.settings, 'apiKey', res.apiKey);
    await this.saveSettings();
    new Notice('Thoth: API key rotated');
  }

  async removeDevice(): Promise<void> {
    const { serverUrl, vaultId, deviceId } = this.settings;
    if (!serverUrl || !vaultId || !deviceId) {
      new Notice('Thoth: device not registered');
      return;
    }
    const res = await removeDevice({ serverUrl, vaultId, deviceId });
    if (!res.ok) {
      new Notice(`Thoth: remove failed – ${res.message}`);
      return;
    }
    this.settings = { ...this.settings, deviceId: '', apiKey: '' };
    await this.saveSettings();
    await this.refreshDeviceList();
    new Notice('Thoth: device removed and local credentials cleared');
  }

  async removeDeviceById(deviceId: string): Promise<void> {
    const { serverUrl, vaultId } = this.settings;
    if (!serverUrl || !vaultId) {
      new Notice('Thoth: server URL and vault ID are required');
      return;
    }
    const res = await removeDevice({ serverUrl, vaultId, deviceId });
    if (!res.ok) {
      new Notice(`Thoth: remove failed – ${res.message}`);
      return;
    }
    if (deviceId === this.settings.deviceId) {
      this.settings = { ...this.settings, deviceId: '', apiKey: '' };
      await this.saveSettings();
      new Notice('Thoth: device removed and local credentials cleared');
    } else {
      new Notice('Thoth: device removed');
    }
    await this.refreshDeviceList();
  }

  async refreshDeviceList(): Promise<void> {
    const { serverUrl, vaultId } = this.settings;
    if (!serverUrl || !vaultId) {
      this.deviceList = [];
      return;
    }
    const res = await listDevices({ serverUrl, vaultId });
    if (res.ok) {
      this.deviceList = res.devices;
    } else {
      this.deviceList = [];
    }
  }

  async createVault(): Promise<void> {
    const { serverUrl } = this.settings;
    if (!serverUrl) {
      new Notice('Thoth: server URL is required');
      return;
    }
    const res = await createVault(serverUrl);
    if (!res.ok) {
      new Notice(`Thoth: create vault failed – ${res.message}`);
      return;
    }
    this.settings = withSetting(this.settings, 'vaultId', res.vaultId);
    this.settings = pushRecentVaultId(this.settings, res.vaultId);
    await this.saveSettings();
    new Notice(`Thoth: vault created ${res.vaultId}`);
  }

  async manualSync(): Promise<void> {
    if (this.scheduler) {
      await this.scheduler.trigger();
    } else {
      await this.performSync();
    }
    new Notice('Thoth: sync triggered');
  }

  pauseSync(): void {
    this.isPaused = true;
    this.scheduler?.stop();
    new Notice('Thoth: synchronization paused');
    this.updateStatusBar();
  }

  resumeSync(): void {
    this.isPaused = false;
    this.scheduler?.start();
    new Notice('Thoth: synchronization resumed');
    this.updateStatusBar();
  }

  /**
   * Forgets the local revision and queue so the next sync re-bootstraps from
   * the server snapshot.
   *
   * Anything still queued here has never reached the server, so dropping it
   * discards unsynced edits. The command is kept for recovering a desynced
   * client, but it now persists the cleared state (otherwise the old queue
   * reappeared on the next load) and refuses outright when work is pending
   * unless the user confirms the loss.
   */
  async resetLocalCache(): Promise<void> {
    const pending = this.queue.size;
    if (pending > 0) {
      const confirmed = await confirmAction(
        this.app,
        `Thoth has ${pending} unsynced change${pending === 1 ? '' : 's'} that ` +
          'have not reached the server. Resetting the local cache discards them.',
        'Discard and reset'
      );
      if (!confirmed) {
        new Notice('Thoth: local cache unchanged');
        return;
      }
    }
    this.serverRevision = 0;
    this.queue.replaceAll([]);
    await this.saveSettings();
    console.debug('Thoth: local cache reset', { discarded: pending });
    new Notice(
      pending > 0
        ? `Thoth: local cache reset, ${pending} unsynced change(s) discarded`
        : 'Thoth: local cache reset'
    );
    this.updateStatusBar();
    void this.scheduler?.trigger();
  }

  async exportSnapshot(): Promise<void> {
    if (!this.settings.serverUrl || !this.settings.vaultId) {
      new Notice('Thoth: configure server and vault first');
      return;
    }
    const snap = await downloadSnapshot({ serverUrl: this.settings.serverUrl, vaultId: this.settings.vaultId });
    if (!snap.ok) {
      new Notice(`Thoth: export failed — ${snap.error}`);
      return;
    }
    const content = JSON.stringify({ revision: snap.revision, files: snap.files, assets: snap.assets ?? {} }, null, 2);
    const path = 'thoth-snapshot.json';
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) await this.app.vault.delete(existing);
    await this.app.vault.create(path, content);
    new Notice(`Thoth: snapshot exported to ${path} rev ${snap.revision}`);
  }

  /**
   * Uploads a `thoth-snapshot.json` to the server, replacing its state.
   *
   * This overwrites the server, so it validates the payload locally before
   * sending and adopts the new revision afterwards. Without adopting it the
   * device keeps pushing against a stale revision, and its next rescan
   * reverts the import by uploading the old local content back over it.
   */
  async importSnapshot(): Promise<void> {
    const { serverUrl, vaultId } = this.settings;
    if (!serverUrl || !vaultId) {
      new Notice('Thoth: configure the server and a vault before importing');
      return;
    }
    const path = 'thoth-snapshot.json';
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      new Notice('Thoth: thoth-snapshot.json not found in vault root');
      return;
    }
    const content = await this.app.vault.read(file as TFile);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      new Notice('Thoth: snapshot JSON malformed');
      return;
    }
    const validated = snapshotSchema(parsed);
    if (!validated.ok) {
      new Notice(
        `Thoth: snapshot is not valid (${validated.issues[0]?.path ?? 'body'}: ${validated.issues[0]?.message ?? 'invalid'})`
      );
      return;
    }
    const confirmed = await confirmAction(
      this.app,
      'Importing replaces the vault on the server with the contents of thoth-snapshot.json. Other devices will receive these files.',
      'Replace server vault'
    );
    if (!confirmed) {
      new Notice('Thoth: import cancelled');
      return;
    }

    const res = await fetch(
      `${serverUrl.replace(/\/+$/, '')}/vaults/${encodeURIComponent(vaultId)}/snapshot`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validated.value),
      }
    );
    if (!res.ok) {
      new Notice(`Thoth: import failed with status ${res.status}`);
      return;
    }
    const body = (await res.json().catch(() => null)) as { revision?: number } | null;
    if (typeof body?.revision === 'number') {
      this.serverRevision = body.revision;
      await this.saveSettings();
    }
    new Notice('Thoth: snapshot imported');
    void this.scheduler?.trigger();
  }

  async syncAssets(): Promise<void> {
    if (this.isPaused) return;
    if (!this.settings.serverUrl || !this.settings.vaultId) return;
    try {
      const snap = await downloadSnapshot({ serverUrl: this.settings.serverUrl, vaultId: this.settings.vaultId });
      if (!snap.ok || !snap.assets) return;
      const adapter = this.createVaultAdapter();
      let downloaded = 0;
      for (const [path, meta] of Object.entries(snap.assets)) {
        if (downloaded >= 5) break; // incremental, avoid blocking
        const exists = await adapter.exists(path);
        if (exists) continue;
        const res = await downloadAsset({ serverUrl: this.settings.serverUrl, vaultId: this.settings.vaultId, assetId: meta.assetId });
        if (!res.ok) {
          console.warn('Thoth: background asset download failed', { path, assetId: meta.assetId, error: res.error });
          continue;
        }
        if (res.data.byteLength > MAX_ASSET_SIZE) {
          console.warn('Thoth: background asset too large, skipped', { path, size: res.data.byteLength });
          continue;
        }
        await adapter.createBinary?.(path, res.data);
        downloaded++;
        console.debug('Thoth: background asset downloaded', { path });
      }
      if (downloaded > 0) new Notice(`Thoth: downloaded ${downloaded} asset(s) in background`);
    } catch (error) {
      console.debug('Thoth: background asset sync failed', error);
    }
  }

  private updateStatusBar(): void {
    if (!this.statusBarEl) return;
    const { serverUrl, vaultId, deviceId, apiKey } = this.settings;
    const configured = Boolean(serverUrl && vaultId && deviceId && apiKey);
    if (!configured) {
      // wizard hints — guide user to the missing step (S1 → S2 → S3)
      let hint = 'not configured';
      let title = 'Thoth is not configured — open Settings → Thoth Sync wizard';
      if (!serverUrl) {
        hint = 'setup → server';
        title = 'Thoth wizard: step 1 — set Server URL';
      } else if (!vaultId) {
        hint = 'setup → vault';
        title = 'Thoth wizard: step 2 — pick or create a Vault';
      } else if (!deviceId || !apiKey) {
        hint = 'setup → device';
        title = 'Thoth wizard: step 3 — Register this device';
      }
      this.statusBarEl.textContent = `Thoth: ${hint}`;
      this.statusBarEl.title = title;
      return;
    }
    // A recorded failure is only meaningful once the wizard is finished, so
    // it is reported here rather than in the not-configured branch — every
    // one of those settings is present at this point, which made the check
    // unreachable where it previously sat.
    const health = this.settings.lastHealthCheck;
    if (health && !health.ok) {
      this.statusBarEl.textContent = `Thoth: ✗ ${health.message.slice(0, 24)}`;
      this.statusBarEl.title = health.message;
      return;
    }
    if (this.isPaused) {
      this.statusBarEl.textContent = 'Thoth: paused';
      this.statusBarEl.title = 'Thoth synchronization is paused';
      return;
    }
    if (this.isSyncing) {
      this.statusBarEl.textContent = 'Thoth: syncing…';
      this.statusBarEl.title = 'Thoth is synchronizing';
      return;
    }
    const live = this.realtimeStatus === 'open' ? '● live' : '○ polling';
    if (this.queue.size > 0) {
      this.statusBarEl.textContent = `Thoth: ${this.queue.size} pending ${live}`;
      this.statusBarEl.title = `${this.queue.size} local changes pending sync`;
      return;
    }
    // Show last known revision as a lightweight heartbeat
    const revText = this.serverRevision
      ? `rev ${this.serverRevision}`
      : 'synced';
    this.statusBarEl.textContent = `Thoth: ${revText} ${live}`;
    this.statusBarEl.title = `Thoth is synced at revision ${this.serverRevision}`;
  }

  private ensureRealtimeClient(): void {
    const { serverUrl, vaultId, deviceId, apiKey } = this.settings;
    const configured = Boolean(serverUrl && vaultId && deviceId && apiKey);
    if (!configured) {
      this.realtimeClient?.close();
      this.realtimeClient = undefined;
      this.realtimeStatus = 'closed';
      this.scheduler?.updateBaseInterval(60_000);
      this.updateStatusBar();
      return;
    }
    if (this.realtimeClient) {
      // already connected with current settings
      return;
    }
    this.scheduler?.updateBaseInterval(300_000);
    this.realtimeClient = connectRealtime({
      serverUrl,
      vaultId,
      deviceId,
      apiKey,
      getLocalRevision: () => this.serverRevision,
      requestSync: () => {
        void this.scheduler?.trigger();
      },
      onStatusChange: (status) => {
        this.realtimeStatus = status;
        this.updateStatusBar();
      },
    });
  }

  /**
   * Runs one sync cycle.
   *
   * Resolves to whether the cycle made progress. The retry scheduler treats
   * `false` as a failure and backs off, so a server that is unreachable stops
   * being polled at the full interval — previously every error was swallowed
   * here and the backoff never engaged.
   */
  private async performSync(): Promise<boolean> {
    if (this.isPaused) {
      console.debug('Thoth: sync paused, skipping');
      return true;
    }
    if (this.isSyncing) {
      console.debug('Thoth: sync already in progress, skipping');
      return true;
    }
    this.isSyncing = true;
    this.applyGuard.reset();
    this.updateStatusBar();
    let syncSucceeded = false;
    try {
      if (
        !this.settings.serverUrl ||
        !this.settings.vaultId ||
        !this.settings.deviceId ||
        !this.settings.apiKey
      ) {
        console.debug('Thoth: sync skipped, settings incomplete');
        return true;
      }

      const startedRevision = this.serverRevision;
      console.debug('Thoth: sync started', {
        revision: startedRevision,
        queueSize: this.queue.size,
      });

      const adapter = this.createVaultAdapter();

      // Restore from snapshot on initial sync before any uploads. The
      // snapshot is also the only authoritative view of what the server
      // holds, so a failed fetch must not be treated as "the server is
      // empty" further down.
      let snapshotFiles: Record<string, string> = {};
      let snapshotAssets: Record<string, SnapshotAsset> = {};
      let haveAuthoritativeSnapshot = false;
      if (this.serverRevision === 0) {
        const restored = await this.restoreFromSnapshot(adapter);
        if (restored) {
          haveAuthoritativeSnapshot = true;
          snapshotFiles = restored.files;
          snapshotAssets = restored.assets;
        }
      }

      // Download missing operations and apply locally first to update revision
      const downloadResult = await downloadAndApply({
        serverUrl: this.settings.serverUrl,
        vaultId: this.settings.vaultId,
        sinceRevision: this.serverRevision,
        vault: adapter,
      });
      if (downloadResult.ok) {
        this.serverRevision = downloadResult.newRevision;
        await this.saveSettings();
        console.debug('Thoth: downloaded', {
          from: startedRevision,
          to: this.serverRevision,
        });
        syncSucceeded = true;
        if (startedRevision === 0) {
          await this.bootstrapLocalVault(
            snapshotFiles,
            snapshotAssets,
            haveAuthoritativeSnapshot
          );
        }
      } else if (downloadResult.needsSnapshot) {
        // The server compacted past this device's revision, so only a full
        // snapshot can bring it forward. Restoring here avoids re-pulling
        // the same truncated history on every tick.
        console.warn('Thoth: history truncated, restoring from snapshot', {
          error: downloadResult.error,
        });
        if (await this.restoreFromSnapshot(adapter)) {
          syncSucceeded = true;
          new Notice(
            'Thoth: local history fell behind the server and was restored from the latest snapshot'
          );
        }
      } else {
        console.warn('Thoth: download failed, will retry on next sync', {
          error: downloadResult.error,
        });
      }

      // Upload queued operations after pulling latest state
      const MAX_BATCH_SIZE = 100;
      while (this.queue.size > 0) {
        // Refresh the server revision before each batch so that operations
        // added by other devices are picked up before we push the next chunk.
        const latest = await downloadOperations({
          serverUrl: this.settings.serverUrl,
          vaultId: this.settings.vaultId,
          sinceRevision: this.serverRevision,
        });
        if (latest.ok && latest.revision > this.serverRevision) {
          // Apply any newly pulled operations to the local vault first
          const adapter = this.createVaultAdapter();
          const fetchAsset = async (assetId: string): Promise<ArrayBuffer | null> => {
            const r = await downloadAsset({
              serverUrl: this.settings.serverUrl,
              vaultId: this.settings.vaultId,
              assetId,
            });
            return r.ok ? r.data : null;
          };
          await applyOperationsToVault(adapter, latest.operations, { fetchAsset });
          this.serverRevision = latest.revision;
          await this.saveSettings();
        }
        const baseRevision = this.serverRevision;
        const uploadAdapter = this.createVaultAdapter();
        // Binary blobs must exist on the server before the operations that
        // reference them are pushed, so assets are uploaded first and any
        // operation whose blob could not be stored is held back.
        const prepared = await this.prepareBatchForPush(
          this.queue.all.slice(0, MAX_BATCH_SIZE),
          uploadAdapter
        );
        if (!prepared.ok) {
          console.warn('Thoth: batch held back, will retry', {
            reason: prepared.reason,
          });
          break;
        }
        const batch = prepared.operations;
        const uploadResult = await uploadOperations({
          serverUrl: this.settings.serverUrl,
          vaultId: this.settings.vaultId,
          baseRevision,
          operations: batch,
        });
        if (!uploadResult.ok) {
          console.warn('Thoth: upload failed, will retry on next sync', {
            error: uploadResult.error,
            baseRevision,
          });
          break;
        }
        const newRevision = uploadResult.newRevision;
        const removed = acknowledgeOperations(
          this.queue,
          baseRevision,
          newRevision
        );
        if (removed === 0) {
          console.warn(
            'Thoth: upload succeeded but no operations were acknowledged, breaking to avoid loop'
          );
          break;
        }
        this.serverRevision = newRevision;
        await this.saveSettings();
        console.debug('Thoth: uploaded batch', {
          uploaded: removed,
          newRevision,
        });
        syncSucceeded = true;
      }
      // Background asset synchronization
      await this.syncAssets();
      return syncSucceeded;
    } catch (error) {
      console.error('Thoth: sync failed with exception', error);
      return false;
    } finally {
      this.isSyncing = false;
      this.updateStatusBar();
      // Provide user feedback only for manual triggers; periodic sync stays silent
    }
  }

  /**
   * Uploads the binary blobs a batch references and returns the operations
   * that are safe to push.
   *
   * An `add-asset` whose file is missing locally, unreadable, or too large
   * to store cannot have its blob uploaded. Pushing it anyway would record
   * an asset in the server snapshot that no other device can download, so
   * the whole batch is held back instead: dropping just that operation
   * would desynchronise the queue positions the server assigns.
   */
  private async prepareBatchForPush(
    batch: readonly Operation[],
    adapter: VaultAdapter
  ): Promise<
    | { ok: true; operations: Operation[] }
    | { ok: false; reason: 'ASSET_UPLOAD_FAILED' | 'ASSET_UNAVAILABLE'; path?: string }
  > {
    for (const op of batch) {
      if (op.type !== 'add-asset') {
        continue;
      }
      const path = op.payload.path;
      if (!(await adapter.exists(path))) {
        console.warn('Thoth: asset file missing, holding back batch', { path });
        return { ok: false, reason: 'ASSET_UNAVAILABLE', path };
      }
      const data = await adapter.readBinary?.(path);
      if (!data) {
        console.warn('Thoth: asset unreadable, holding back batch', { path });
        return { ok: false, reason: 'ASSET_UNAVAILABLE', path };
      }
      if (data.byteLength > MAX_ASSET_SIZE) {
        console.warn('Thoth: asset too large to store, holding back batch', {
          path,
          size: data.byteLength,
        });
        return { ok: false, reason: 'ASSET_UNAVAILABLE', path };
      }
      const res = await uploadAsset({
        serverUrl: this.settings.serverUrl,
        vaultId: this.settings.vaultId,
        assetId: op.payload.assetId,
        data,
        mimeType: op.payload.mimeType,
      });
      if (!res.ok) {
        console.warn('Thoth: asset upload failed, holding back batch', {
          assetId: op.payload.assetId,
          error: res.error,
        });
        return { ok: false, reason: 'ASSET_UPLOAD_FAILED', path };
      }
    }
    return { ok: true, operations: [...batch] };
  }

  /**
   * Fetches the server snapshot, writes it to the vault and adopts its
   * revision.
   *
   * Returns null when the snapshot could not be read, so callers can tell
   * "the server is empty" apart from "the server is unreachable" — the
   * distinction decides whether local files may be uploaded.
   */
  private async restoreFromSnapshot(
    adapter: VaultAdapter
  ): Promise<{ files: Record<string, string>; assets: Record<string, SnapshotAsset> } | null> {
    const { serverUrl, vaultId } = this.settings;
    if (!serverUrl || !vaultId) {
      return null;
    }
    const snapshotResult = await downloadSnapshot({ serverUrl, vaultId });
    if (!snapshotResult.ok) {
      console.warn('Thoth: snapshot restore failed', { error: snapshotResult.error });
      return null;
    }
    const assets = snapshotResult.assets ?? {};
    await applySnapshotToVault(adapter, snapshotResult.files);
    for (const [path, meta] of Object.entries(assets)) {
      const assetRes = await downloadAsset({ serverUrl, vaultId, assetId: meta.assetId });
      if (!assetRes.ok) {
        console.warn('Thoth: snapshot asset download failed', {
          path,
          assetId: meta.assetId,
          error: assetRes.error,
        });
        continue;
      }
      if (await adapter.exists(path)) {
        await adapter.modifyBinary?.({ path }, assetRes.data);
      } else {
        await adapter.createBinary?.(path, assetRes.data);
      }
    }
    this.serverRevision = snapshotResult.revision;
    await this.saveSettings();
    console.debug('Thoth: restored from snapshot', {
      revision: snapshotResult.revision,
      files: Object.keys(snapshotResult.files).length,
      assets: Object.keys(assets).length,
    });
    return { files: snapshotResult.files, assets };
  }

  /**
   * Queues local files the server does not have yet.
   *
   * This only runs on a device's first sync, where local and server state
   * have never been compared. The comparison is delegated to
   * `planBootstrap`, which refuses to upload anything unless the server
   * snapshot was actually read.
   */
  private async bootstrapLocalVault(
    serverFiles: Record<string, string>,
    serverAssets: Record<string, SnapshotAsset>,
    haveAuthoritativeSnapshot: boolean
  ): Promise<void> {
    if (!this.settings.deviceId) {
      console.debug('Thoth: bootstrap skipped, device not configured');
      return;
    }
    if (!haveAuthoritativeSnapshot) {
      console.warn(
        'Thoth: bootstrap skipped — the server snapshot could not be read, so local files cannot be compared against it'
      );
      new Notice(
        'Thoth: could not read the server snapshot, so local files were not uploaded. Use "Rescan vault" once the server is reachable.'
      );
      return;
    }
    // keep recent vaults picker in sync — bootstrap implies this vault is active
    if (this.settings.vaultId && !this.settings.lastVaultIds.includes(this.settings.vaultId)) {
      this.settings = pushRecentVaultId(this.settings, this.settings.vaultId);
      await this.saveSettings();
    }
    const extensions = new Set(this.settings.syncedExtensions.map((e) => e.toLowerCase()));
    const syncedFiles = this.app.vault
      .getFiles()
      .filter((file) => extensions.has(file.extension.toLowerCase()));

    const localFiles: LocalEntry[] = [];
    for (const file of syncedFiles) {
      if (!isBinaryPath(file.path)) {
        localFiles.push({
          kind: 'text',
          path: file.path,
          content: await this.app.vault.read(file),
        });
        continue;
      }
      const buffer = await this.app.vault.readBinary(file);
      if (buffer.byteLength > MAX_ASSET_SIZE) {
        console.warn('Thoth: asset too large in bootstrap, skipped', {
          path: file.path,
          size: buffer.byteLength,
        });
        localFiles.push({
          kind: 'skipped',
          path: file.path,
          reason: 'too large',
        });
        continue;
      }
      const mimeType = mimeTypeForPath(file.path);
      localFiles.push({
        kind: 'binary',
        path: file.path,
        hash: await hashArrayBuffer(buffer),
        size: buffer.byteLength,
        ...(mimeType ? { mimeType } : {}),
      });
    }

    const plan = planBootstrap({
      haveAuthoritativeSnapshot,
      deviceId: this.settings.deviceId,
      serverFiles,
      serverAssets,
      assetIdForPath,
      localFiles,
    });
    if (!plan.ok) {
      console.debug('Thoth: bootstrap produced no drafts', { reason: plan.reason });
      return;
    }
    for (const draft of plan.drafts) {
      await this.queue.enqueue(draft, this.settings.deviceId);
    }
    if (plan.drafts.length > 0) {
      await this.saveQueue(this.queue);
      console.debug('Thoth: bootstrapped local vault', {
        enqueued: plan.drafts.length,
      });
    }
  }

  async rescanVault(): Promise<void> {
    if (!this.settings.serverUrl || !this.settings.vaultId || !this.settings.deviceId) {
      new Notice('Thoth: configure server, vault and device first');
      return;
    }
    new Notice('Thoth: rescanning vault…');
    try {
      const snap = await downloadSnapshot({ serverUrl: this.settings.serverUrl, vaultId: this.settings.vaultId });
      if (!snap.ok) {
        new Notice(`Thoth: rescan failed — ${snap.error}`);
        return;
      }
      const extensions = new Set(this.settings.syncedExtensions.map((e) => e.toLowerCase()));
      const allFiles = this.app.vault.getFiles();
      const syncedFiles = allFiles.filter((f) => extensions.has(f.extension.toLowerCase()));
      const queuedPaths = new Set<string>();
      for (const op of this.queue.all) {
        const p = (op.payload as { path?: string; newPath?: string }).path ?? (op.payload as { newPath?: string }).newPath;
        if (p) queuedPaths.add(p);
        const old = (op.payload as { oldPath?: string }).oldPath;
        if (old) queuedPaths.add(old);
      }
      let enqueued = 0;
      for (const file of syncedFiles) {
        const path = file.path;
        if (queuedPaths.has(path)) continue;
        const isBinary = isBinaryPath(path);
        if (isBinary) {
          const serverMeta = snap.assets?.[path];
          const buffer = await this.app.vault.readBinary(file);
          if (buffer.byteLength > MAX_ASSET_SIZE) continue;
          const hash = await hashArrayBuffer(buffer);
          if (!serverMeta) {
            const assetId = assetIdForPath(path);
            const mimeType = mimeTypeForPath(path);
            await this.queue.enqueue(
              { type: 'add-asset', payload: { path, assetId, hash, size: buffer.byteLength, ...(mimeType ? { mimeType } : {}) } },
              this.settings.deviceId
            );
            enqueued++;
          } else if (serverMeta.hash !== hash) {
            const assetId = assetIdForPath(path);
            const mimeType = mimeTypeForPath(path);
            await this.queue.enqueue(
              { type: 'add-asset', payload: { path, assetId, hash, size: buffer.byteLength, ...(mimeType ? { mimeType } : {}) } },
              this.settings.deviceId
            );
            enqueued++;
          }
        } else {
          const serverContent = snap.files[path];
          const localContent = await this.app.vault.read(file);
          if (serverContent === undefined) {
            await this.queue.enqueue({ type: 'create-note', payload: { path, content: localContent } }, this.settings.deviceId);
            enqueued++;
          } else if (localContent !== serverContent) {
            await this.queue.enqueue({ type: 'replace-content', payload: { path, content: localContent } }, this.settings.deviceId);
            enqueued++;
          }
        }
      }
      if (enqueued > 0) {
        await this.saveQueue(this.queue);
        new Notice(`Thoth: rescan enqueued ${enqueued} file(s)`);
        void this.scheduler?.trigger();
      } else {
        new Notice('Thoth: rescan — nothing missing');
      }
      this.updateStatusBar();
    } catch (error) {
      console.error('Thoth: rescan failed', error);
      new Notice(`Thoth: rescan failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private createVaultAdapter(): VaultAdapter {
    const vault = this.app.vault;
    // Obsidian's read/modify/rename take a TFile, but getAbstractFileByPath
    // returns a TAbstractFile that may be a folder. Resolving to a TFile here
    // keeps the cast in one place instead of at every call site.
    const fileAt = (path: string): TFile | null => {
      const file = vault.getAbstractFileByPath(path);
      return file instanceof TFile ? file : null;
    };
    const ensureFolders = async (path: string): Promise<void> => {
      const parts = path.split('/');
      parts.pop();
      let folderPath = '';
      for (const part of parts) {
        folderPath = folderPath ? `${folderPath}/${part}` : part;
        const existing = vault.getAbstractFileByPath(folderPath);
        if (!existing) {
          await vault.createFolder(folderPath);
        }
      }
    };
    return {
      exists: (path: string) =>
        Promise.resolve(vault.getAbstractFileByPath(path) !== null),
      read: async (path: string) => {
        const file = fileAt(path);
        if (!file) {
          throw new Error(`File not found: ${path}`);
        }
        return await vault.read(file);
      },
      readBinary: async (path: string) => {
        const file = fileAt(path);
        if (!file) {
          throw new Error(`File not found: ${path}`);
        }
        return await vault.readBinary(file);
      },
      create: async (path: string, content: string) => {
        await ensureFolders(path);
        this.applyGuard.recordText(path, content);
        await vault.create(path, content);
      },
      createBinary: async (path: string, data: ArrayBuffer) => {
        await ensureFolders(path);
        this.applyGuard.recordBinary(path, await hashArrayBuffer(data));
        await vault.createBinary(path, data);
      },
      modify: async (file: { path: string }, content: string) => {
        const f = fileAt(file.path);
        if (f) {
          this.applyGuard.recordText(file.path, content);
          await vault.modify(f, content);
        }
      },
      modifyBinary: async (file: { path: string }, data: ArrayBuffer) => {
        const f = fileAt(file.path);
        if (f) {
          this.applyGuard.recordBinary(file.path, await hashArrayBuffer(data));
          await vault.modifyBinary(f, data);
        }
      },
      rename: async (file: { path: string }, newPath: string) => {
        const f = fileAt(file.path);
        if (f) {
          this.applyGuard.recordPath(file.path);
          this.applyGuard.recordPath(newPath);
          await vault.rename(f, newPath);
        }
      },
      delete: async (path: string) => {
        const file = vault.getAbstractFileByPath(path);
        if (file) {
          this.applyGuard.recordPath(path);
          await vault.delete(file);
        }
      },
    };
  }

  private storage(): Persistence {
    return {
      loadData: () => this.loadData(),
      saveData: (data) => this.saveData(data),
    };
  }
}

export default ThothPlugin;
