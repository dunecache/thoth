import { App, Modal } from 'obsidian';

/**
 * A yes/no confirmation dialog.
 *
 * Used only for destructive actions where proceeding discards data, so a
 * Notice is not enough. Built on Obsidian's Modal so it renders natively on
 * desktop and mobile rather than relying on `window.confirm`.
 */
class ConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly message: string,
    private readonly confirmLabel: string,
    private readonly resolve: (confirmed: boolean) => void
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('p', { text: this.message });

    const row = contentEl.createDiv({ cls: 'modal-button-container' });
    const cancel = row.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.settle(false));

    const confirm = row.createEl('button', {
      text: this.confirmLabel,
      cls: 'mod-warning',
    });
    confirm.addEventListener('click', () => this.settle(true));
    confirm.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
    // Dismissing the dialog without choosing counts as a cancel.
    this.settle(false);
  }

  private settle(confirmed: boolean): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolve(confirmed);
    this.close();
  }
}

/** Shows a confirmation dialog and resolves with the user's choice. */
export function confirmAction(
  app: App,
  message: string,
  confirmLabel = 'Confirm'
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    new ConfirmModal(app, message, confirmLabel, resolve).open();
  });
}
