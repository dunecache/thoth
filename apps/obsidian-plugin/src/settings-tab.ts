import { App, Notice, PluginSettingTab, Setting, TextComponent } from 'obsidian';

import {
  buildInviteLink,
  checkHealth,
  parseImportVaultLink,
  validateServerUrl,
} from './api.js';
import { copyToClipboard } from './clipboard.js';
import type { ThothPlugin } from './main.js';
import { pushRecentVaultId, withSetting, type ThothSettings } from './settings.js';
import { defaultDeviceName } from './device-name.js';

export class ThothSettingTab extends PluginSettingTab {
  private readonly plugin: ThothPlugin;

  constructor(app: App, plugin: ThothPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // Refresh device list silently on each open
    void this.plugin.refreshDeviceList();

    containerEl.createEl('h2', { text: 'Setup wizard — one field' });

    const serverValidation = validateServerUrl(this.plugin.settings.serverUrl);
    const hasServer = serverValidation.ok;
    const hasVault = Boolean(this.plugin.settings.vaultId);

    // S1 — Server URL with inline health check
    const serverSetting = new Setting(containerEl)
      .setName('1. Server URL')
      .setDesc(
        hasServer ? '✓ Valid URL — click Check to verify reachability' : 'Base URL of the Thoth sync server, e.g. https://sync.example.com'
      );
    serverSetting.addText((text) => {
      this.bindConfig(text, 'serverUrl', 'https://sync.example.com');
      text.inputEl.addEventListener('blur', () => this.display());
    });
    serverSetting.addButton((btn) =>
      btn
        .setButtonText('Check')
        .setDisabled(!hasServer)
        .onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText('Checking…');
          const res = await checkHealth(this.plugin.settings.serverUrl);
          new Notice(res.ok ? `✓ ${res.message}` : `✗ ${res.message}`);
          this.display();
        })
    );
    if (!hasServer && this.plugin.settings.serverUrl) {
      serverSetting.setDesc(`✗ ${serverValidation.ok ? '' : (serverValidation).error}`);
    }

    // S2 — Vault picker
    const vaultSetting = new Setting(containerEl).setName('2. Vault').setDesc(
      hasVault
        ? `Vault ID: ${this.plugin.settings.vaultId}`
        : 'Create a new vault or import via thoth:// link'
    );
    // Recent vaults dropdown
    if (this.plugin.settings.lastVaultIds.length > 0) {
      vaultSetting.addDropdown((dd) => {
        dd.addOption('', '— Recent vaults —');
        for (const id of this.plugin.settings.lastVaultIds) {
          dd.addOption(id, `${id.slice(0, 8)}…`);
        }
        const current = this.plugin.settings.vaultId;
        dd.setValue(current && this.plugin.settings.lastVaultIds.includes(current) ? current : '');
        dd.onChange(async (value) => {
          if (!value) return;
          this.plugin.settings = withSetting(this.plugin.settings, 'vaultId', value);
          this.plugin.settings = pushRecentVaultId(this.plugin.settings, value);
          await this.plugin.saveSettings();
          await this.plugin.refreshDeviceList();
          const list = this.plugin.deviceList ?? [];
          if (!list.some((d) => d.id === this.plugin.settings.deviceId)) {
            await this.plugin.registerDevice();
          }
          this.display();
        });
      });
    }
    vaultSetting.addButton((btn) =>
      btn
        .setButtonText('Create new vault')
        .setDisabled(!hasServer)
        .onClick(async () => {
          await this.plugin.createVault();
          await this.plugin.refreshDeviceList();
          const list = this.plugin.deviceList ?? [];
          if (!list.some((d) => d.id === this.plugin.settings.deviceId)) {
            await this.plugin.registerDevice();
          }
          this.display();
        })
    );
    // Server vaults list after Server URL (GET /vaults)
    // Import link. The text component is captured in a local so the button
    // handler can read it, rather than being stashed on the Setting object.
    let importField = '';
    new Setting(containerEl)
      .setName('Import vault link')
      .setDesc('Paste thoth://?serverUrl=https://...&vaultId=... from another device')
      .addText((text) => {
        text.setPlaceholder('thoth://?serverUrl=https://...&vaultId=...');
        text.inputEl.style.minWidth = '260px';
        text.onChange((value: string) => {
          importField = value;
        });
      })
      .addButton((btn) =>
        btn.setButtonText('Import').onClick(async () => {
          const link = importField.trim();
          const parsed = parseImportVaultLink(link);
          if (!parsed) {
            new Notice('✗ Invalid thoth:// link');
            return;
          }
          this.plugin.settings = withSetting(this.plugin.settings, 'serverUrl', parsed.serverUrl);
          this.plugin.settings = withSetting(this.plugin.settings, 'vaultId', parsed.vaultId);
          this.plugin.settings = pushRecentVaultId(this.plugin.settings, parsed.vaultId);
          await this.plugin.saveSettings();
          new Notice(`✓ Imported vault ${parsed.vaultId.slice(0, 8)}…`);
          // auto-register for imported vault
          await this.plugin.registerDevice();
          this.display();
        })
      );

    // Invite — the inverse of the import field above. Without this there is
    // no way to bring a second device onto a vault: the server no longer lists
    // vaults, so the link is the only route in.
    const inviteLink = buildInviteLink(
      this.plugin.settings.serverUrl,
      this.plugin.settings.vaultId
    );
    if (inviteLink) {
      let inviteField: TextComponent | null = null;
      new Setting(containerEl)
        .setName('Invite another device')
        .setDesc(
          'Send this link to the other device, then paste it into "Import vault link" there. ' +
            'It contains no credential — that device registers itself and gets its own key.'
        )
        .addText((text) => {
          text.setValue(inviteLink);
          text.setDisabled(true);
          text.inputEl.style.minWidth = '260px';
          inviteField = text;
        })
        .addButton((btn) =>
          btn.setButtonText('Copy').onClick(async () => {
            const copied = await copyToClipboard(inviteLink);
            if (copied) {
              new Notice('✓ Invite link copied');
              return;
            }
            // Clipboard access is unavailable on some platforms. Selecting the
            // text means the user can copy it without leaving Obsidian.
            inviteField?.inputEl?.select();
            new Notice('Copy the selected link manually');
          })
        );
    }

    new Setting(containerEl)
      .setName('Synced file extensions')
      .setDesc(
        'Comma-separated extensions synchronized as text files (e.g. md, base, canvas). Binary assets (png, pdf) and .base use add-asset.'
      )
      .addText((text) => {
        text
          .setPlaceholder('md, base')
          .setValue(this.plugin.settings.syncedExtensions.join(', '))
          .onChange(async (value: string) => {
            const extensions = value
              .split(',')
              .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
              .filter(Boolean);
            this.plugin.settings = withSetting(
              this.plugin.settings,
              'syncedExtensions',
              extensions.length > 0 ? extensions : ['md', 'base']
            );
            await this.plugin.saveSettings();
          });
      });

    // S3 — Device (auto deviceId) — registeredForThisVault matters after vault switch
    const { deviceId, apiKey, deviceName } = this.plugin.settings;
    const registered = Boolean(deviceId && apiKey);
    const listForS3 = this.plugin.deviceList ?? [];
    const isRegisteredForThisVault = registered && listForS3.some((d) => d.id === deviceId);

    if (registered && isRegisteredForThisVault) {
      new Setting(containerEl)
        .setName('3. Current device ✓')
        .setDesc(
          `Registered as ${deviceName || 'Unknown'} (${deviceId.slice(0, 8)}…) • apiKey ••••`
        )
        .addButton((btn) =>
          btn
            .setButtonText('Remove this device')
            .onClick(() => void this.plugin.removeDevice())
        )
        .addButton((btn) =>
          btn
            .setButtonText('Rotate API key')
            .onClick(() => void this.plugin.rotateApiKey())
        )
        .addButton((btn) =>
          btn
            .setButtonText('Check connection')
            .onClick(() => void this.plugin.checkConnection())
        );
    } else {
      if (this.plugin.authFailure) {
        new Setting(containerEl)
          .setName('3. This device was removed from the vault')
          .setDesc(
            `${this.plugin.authFailure.reason}. Sync is paused — register this ` +
              'device again to resume. Your unsynced changes are kept and will ' +
              'upload afterwards.'
          );
      }
      new Setting(containerEl)
        .setName('3. Device name')
        .setDesc('Human-readable name for this device (auto deviceId)')
        .addText((text) => {
          const value = deviceName || defaultDeviceName();
          text
            .setPlaceholder(defaultDeviceName())
            .setValue(value)
            .onChange(async (v) => {
              this.plugin.settings = withSetting(
                this.plugin.settings,
                'deviceName',
                v
              );
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName('Register device')
        .setDesc(hasVault ? 'Ready to register' : 'Select a vault (step 2) first')
        .addButton((btn) =>
          btn
            .setButtonText(
              this.plugin.authFailure
                ? 'Register this device again'
                : 'Register this device'
            )
            .setDisabled(!hasVault || !hasServer)
            .onClick(async () => {
              await this.plugin.registerDevice();
              this.display();
            })
        );
    }

    // Devices list
    new Setting(containerEl)
      .setName('Registered devices')
      .setDesc('Shows all devices for this vault')
      .addButton((btn) =>
        btn.setButtonText('Refresh list').onClick(async () => {
          await this.plugin.refreshDeviceList();
          this.display();
        })
      );

    const list = this.plugin.deviceList ?? [];
    if (list.length === 0) {
      // An empty list previously covered three different situations, so a
      // revoked device read as "not loaded yet". Say which one it is.
      new Setting(containerEl)
        .setName(
          this.plugin.deviceListError ? 'Could not load devices' : 'No devices'
        )
        .setDesc(
          this.plugin.deviceListError
            ? `${this.plugin.deviceListError}`
            : 'No device is registered on this vault yet.'
        );
    } else {
      for (const d of list) {
        const isCurrent = d.id === deviceId;
        new Setting(containerEl)
          .setName(isCurrent ? d.name || d.id : d.name || d.id)
          .setDesc(
            `ID: ${d.id} • created ${new Date(d.createdAt).toLocaleDateString()}${isCurrent ? ' • current' : ''}`
          )
          .addButton((btn) =>
            btn
              .setButtonText('Remove')
              .setWarning()
              .onClick(async () => {
                await this.plugin.removeDeviceById(d.id);
                this.display();
              })
          );
      }
    }

    // Connection diagnostics & sync statistics — inline, no Notice spam (health cache)
    const hc = this.plugin.settings.lastHealthCheck;
    new Setting(containerEl)
      .setName('Connection diagnostics')
      .setDesc(hc ? `${hc.ok ? '✓' : '✗'} ${hc.message} — ${new Date(hc.at).toLocaleString()} (${hc.url || 'no url'})` : 'Test connection and view sync statistics — inline status, not Notices')
      .addButton((btn) =>
        btn
          .setButtonText('Test connection')
          .onClick(async () => {
            await this.plugin.checkConnection();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName('Sync statistics')
      .setDesc(
        `Revision: ${this.plugin.serverRevision} • Queue: ${this.plugin.queue.size} • Last sync: ${new Date().toLocaleString()}`
      );
  }

  private bindConfig(
    text: TextComponent,
    key: Extract<keyof ThothSettings, 'serverUrl' | 'vaultId' | 'deviceId' | 'apiKey' | 'deviceName'>,
    placeholder: string
  ): void {
    text
      .setPlaceholder(placeholder)
      .setValue(this.plugin.settings[key])
      .onChange(async (value: string) => {
        this.plugin.settings = withSetting(this.plugin.settings, key, value);
        await this.plugin.saveSettings();
      });
  }
}
