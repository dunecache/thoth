/**
 * Runtime stand-in for the `obsidian` module.
 *
 * The published package ships type declarations only — there is no runtime
 * entry — so any test that imports a module referencing it needs this stub.
 * `vitest.config.ts` aliases `obsidian` here.
 */

export class Notice {
  /** Every notice raised, so tests can assert on user-visible messaging. */
  static readonly raised: string[] = [];

  message: string;

  constructor(message: string) {
    this.message = message;
    Notice.raised.push(message);
  }

  setMessage(message: string): this {
    this.message = message;
    return this;
  }

  hide(): void {}
}

export class TFile {
  path = '';
  name = '';
  extension = '';
  basename = '';
  stat: { ctime: number; mtime: number; size: number } = {
    ctime: 0,
    mtime: 0,
    size: 0,
  };
  vault: unknown = null;
  parent: unknown = null;
}

export class TFolder {
  path = '';
  name = '';
  children: unknown[] = [];
  parent: unknown = null;
}

export class TAbstractFile {
  path = '';
  name = '';
  vault: unknown = null;
  parent: unknown = null;
}

/**
 * The blob `loadData`/`saveData` read and write, so a test can seed persisted
 * state and observe what the plugin wrote back.
 */
export const pluginStore = {
  data: null as unknown,
};

export class Plugin {
  constructor(
    public app: unknown,
    public manifest?: unknown
  ) {}

  addCommand(spec: unknown): unknown {
    return spec;
  }
  addRibbonIcon(): unknown {
    return {};
  }
  addStatusBarItem(): HTMLElement {
    return { textContent: '', title: '' } as unknown as HTMLElement;
  }
  addSettingTab(): void {}
  registerDomEvent(): void {}
  registerEvent(): void {}
  registerInterval(id: number): number {
    return id;
  }
  // Matches the real signature; the store is synchronous, so these resolve
  // immediately rather than pretending to await storage.
  loadData(): Promise<unknown> {
    return Promise.resolve(pluginStore.data);
  }
  saveData(data: unknown): Promise<void> {
    pluginStore.data = data;
    return Promise.resolve();
  }
}

export class PluginSettingTab {
  containerEl: unknown = null;
  constructor(
    public app: unknown,
    public plugin: unknown
  ) {}
  display(): void {}
  hide(): void {}
}

export class Modal {
  contentEl: unknown = { empty: () => {}, createEl: () => ({ addEventListener: () => {}, focus: () => {} }), createDiv: () => ({ createEl: () => ({ addEventListener: () => {}, focus: () => {} }) }) };
  constructor(public app: unknown) {}
  open(): void {
    this.onOpen();
  }
  close(): void {
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
}

export class Setting {
  constructor(public containerEl?: unknown) {}
  setName(): this {
    return this;
  }
  setDesc(): this {
    return this;
  }
  setDisabled(): this {
    return this;
  }
  addText(): this {
    return this;
  }
  addButton(): this {
    return this;
  }
  addToggle(): this {
    return this;
  }
  addDropdown(): this {
    return this;
  }
}

export class App {}
export class Vault {}
export class Events {}
export class Component {}
export class MarkdownView {}
export class ItemView {}
export class PluginManifest {}
export class TextComponent {}
export class ButtonComponent {}
export class Notice_ {}
