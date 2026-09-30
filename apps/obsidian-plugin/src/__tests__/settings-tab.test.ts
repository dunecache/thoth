import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Rendering tests for the settings tab.
 *
 * The tab had no coverage at all, which is how it came to display only the
 * first 8 characters of a vault id and offered no way to produce the invite
 * link its own import field expects. There is no DOM in this project, so the
 * Obsidian primitives are replaced with recorders: enough to assert which
 * settings appear, with what text, and what the buttons do.
 */

interface RecordedText {
  value: string;
  placeholder?: string;
  disabled: boolean;
  inputEl: {
    style: Record<string, string>;
    select: () => void;
    selected: boolean;
    addEventListener: (...args: unknown[]) => void;
  };
  changeHandler: ((value: string) => void) | null;
}

interface RecordedButton {
  label: string;
  disabled: boolean;
  handler: (() => void | Promise<void>) | null;
}

interface RecordedSetting {
  name: string;
  desc: string;
  texts: RecordedText[];
  buttons: RecordedButton[];
  dropdowns: { options: string[]; onChange: ((v: string) => void) | null }[];
}

const rendered: RecordedSetting[] = [];
const notices: string[] = [];

vi.mock('obsidian', () => {
  class TextComponent {
    value = '';
    placeholder?: string;
    disabled = false;
    /** The registered change handler, if any. */
    changeHandler: ((value: string) => void) | null = null;
    inputEl = {
      style: {} as Record<string, string>,
      selected: false,
      select: () => {
        this.inputEl.selected = true;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    setValue(v: string) {
      this.value = v;
      return this;
    }
    setPlaceholder(v: string) {
      this.placeholder = v;
      return this;
    }
    setDisabled(v: boolean) {
      this.disabled = v;
      return this;
    }
    onChange(fn: (value: string) => void) {
      this.changeHandler = fn;
      return this;
    }
  }

  class ButtonComponent {
    label = '';
    disabled = false;
    handler: (() => void | Promise<void>) | null = null;
    setButtonText(v: string) {
      this.label = v;
      return this;
    }
    setDisabled(v: boolean) {
      this.disabled = v;
      return this;
    }
    setWarning() {
      return this;
    }
    onClick(fn: () => void | Promise<void>) {
      this.handler = fn;
      return this;
    }
  }

  class Setting {
    texts: RecordedText[] = [];
    buttons: RecordedButton[] = [];
    dropdowns: { options: string[]; onChange: ((v: string) => void) | null }[] = [];
    private name = '';
    private desc = '';

    /** The record this Setting publishes, for assertions. */
    readonly record = {
      name: '',
      desc: '',
      texts: [] as RecordedText[],
      buttons: [] as RecordedButton[],
      dropdowns: [] as { options: string[]; onChange: ((v: string) => void) | null }[],
    };

    // The container is unused: the recorder only needs the setting's text.
    constructor(containerEl?: unknown) {
      void containerEl;
      rendered.push(this.record);
    }
    setName(v: string) {
      this.record.name = v;
      return this;
    }
    setDesc(v: string) {
      this.record.desc = v;
      return this;
    }
    addText(cb: (t: unknown) => unknown) {
      const t = new TextComponent();
      cb(t);
      this.record.texts.push(t as unknown as RecordedText);
      return this;
    }
    addButton(cb: (b: unknown) => unknown) {
      const b = new ButtonComponent();
      cb(b);
      this.record.buttons.push(b as unknown as RecordedButton);
      return this;
    }
    addDropdown(cb: (d: unknown) => unknown) {
      const record = { options: [] as string[], onChange: null as ((v: string) => void) | null };
      cb({
        addOption: (v: string) => record.options.push(v),
        setValue: () => undefined,
        onChange: (fn: (v: string) => void) => {
          record.onChange = fn;
        },
      });
      this.record.dropdowns.push(record);
      return this;
    }
    addToggle() {
      return this;
    }
  }

  class PluginSettingTab {
    containerEl = {
      empty: () => undefined,
      createEl: () => ({}),
      createDiv: () => ({}),
    };
    constructor(
      public app: unknown,
      public plugin: unknown
    ) {}
    display(): void {}
  }

  class Notice {
    constructor(message: string) {
      notices.push(message);
    }
  }

  // device-name.ts reads Platform to label the default device.
  const Platform = {
    isMobileApp: false,
    isDesktopApp: true,
    isIosApp: false,
    isAndroidApp: false,
  };

  return {
    Setting,
    PluginSettingTab,
    Notice,
    App: class {},
    TextComponent,
    ButtonComponent,
    Platform,
  };
});

const { ThothSettingTab } = await import('../settings-tab.js');
const { DEFAULT_SETTINGS } = await import('../settings.js');

const VAULT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function createPlugin(overrides: Record<string, unknown> = {}) {
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      serverUrl: 'https://sync.example.com',
      vaultId: VAULT_ID,
      deviceId: 'dev-1',
      apiKey: 'key-1',
      deviceName: 'Test',
      ...overrides,
    },
    deviceList: [],
    authFailure: undefined,
    // Read by the Sync statistics row and the status of the device list.
    queue: { size: 0, all: [] },
    serverRevision: 12,
    deviceListError: undefined,
    async refreshDeviceList() {},
    async saveSettings() {},
    async registerDevice() {
      return true;
    },
    async createVault() {},
    async checkConnection() {},
    async rotateApiKey() {},
    async removeDevice() {},
  };
}

function render(plugin: unknown): RecordedSetting[] {
  rendered.length = 0;
  const tab = new ThothSettingTab({} as never, plugin as never);
  (tab as unknown as { display(): void }).display();
  return rendered;
}

function find(nameFragment: string): RecordedSetting | undefined {
  return rendered.find((s) => s.name.includes(nameFragment));
}

beforeEach(() => {
  rendered.length = 0;
  notices.length = 0;
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('invite link', () => {
  it('offers an invite link once a server and vault are configured', () => {
    render(createPlugin());

    const invite = find('Invite another device');
    expect(invite).toBeDefined();
    const link = invite?.texts[0]?.value ?? '';
    expect(link).toBe(
      `thoth://?serverUrl=https%3A%2F%2Fsync.example.com&vaultId=${VAULT_ID}`
    );
  });

  it('makes the link read-only and explains it carries no credential', () => {
    render(createPlugin());

    const invite = find('Invite another device');
    expect(invite?.texts[0]?.disabled).toBe(true);
    expect(invite?.desc).toMatch(/no credential/i);
  });

  it('never puts the API key in the link', () => {
    render(createPlugin({ apiKey: 'super-secret-key' }));

    const link = find('Invite another device')?.texts[0]?.value ?? '';
    expect(link).not.toContain('super-secret-key');
  });

  it('is absent before a vault is chosen', () => {
    render(createPlugin({ vaultId: '' }));

    expect(find('Invite another device')).toBeUndefined();
  });

  it('is absent when the server url is not set', () => {
    render(createPlugin({ serverUrl: '' }));

    expect(find('Invite another device')).toBeUndefined();
  });
});

describe('vault identification', () => {
  it('shows the full vault id, not a truncated prefix', () => {
    render(createPlugin());

    const desc = find('2. Vault')?.desc ?? '';
    // The id has to be readable in full: it is what a second device needs,
    // and 8 characters cannot be pasted anywhere.
    expect(desc).toContain(VAULT_ID);
    expect(desc).not.toMatch(/…|\.\.\./);
  });
});

describe('copying the invite link', () => {
  it('copies and confirms', async () => {
    const copied: string[] = [];
    const writeText = vi.fn(async (text: string) => {
      copied.push(text);
    });
    Object.defineProperty(globalThis, 'navigator', {
      // userAgent is read by device-name.ts to label the default device.
      value: { clipboard: { writeText }, userAgent: 'Obsidian' },
      configurable: true,
      writable: true,
    });

    render(createPlugin());
    const copy = find('Invite another device')?.buttons.find(
      (b) => b.label === 'Copy'
    );
    await copy?.handler?.();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(copied[0]).toContain(VAULT_ID);
    expect(notices.some((n) => n.includes('copied'))).toBe(true);
  });

  it('falls back to selecting the text when the clipboard is unavailable', async () => {
    // Clipboard access is not guaranteed on every Obsidian platform, and a
    // dead Copy button would strand the user.
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Obsidian' },
      configurable: true,
      writable: true,
    });

    render(createPlugin());
    const invite = find('Invite another device');
    await invite?.buttons.find((b) => b.label === 'Copy')?.handler?.();

    expect(invite?.texts[0]?.inputEl.selected).toBe(true);
    expect(notices.some((n) => n.toLowerCase().includes('manually'))).toBe(true);
  });
});
