import type { OperationDraft } from './queue.js';

/** A normalized low-level change detected in the vault. */
export type FileChange =
  | { kind: 'create'; path: string; content: string }
  | { kind: 'modify'; path: string; content: string }
  | { kind: 'rename'; oldPath: string; newPath: string }
  | { kind: 'delete'; path: string }
  /**
   * A folder rename, which moves a whole subtree.
   *
   * Kept distinct from `rename` because Obsidian follows the folder's own
   * rename event with one per descendant file. Emitting per-file renames
   * instead moved the files but left the old folder — and any nested folder —
   * standing empty on every other device, since nothing ever said they should
   * go away.
   */
  | { kind: 'rename-folder'; oldPath: string; newPath: string };

/**
 * Maps a normalized file change to an operation draft. Pure and
 * deterministic; ids, device and revisions are assigned by the queue.
 */
export function changeToDraft(change: FileChange): OperationDraft {
  switch (change.kind) {
    case 'create':
      return {
        type: 'create-note',
        payload: { path: change.path, content: change.content },
      };
    case 'modify':
      return {
        type: 'replace-content',
        payload: { path: change.path, content: change.content },
      };
    case 'rename':
      return {
        type: 'rename-note',
        payload: { oldPath: change.oldPath, newPath: change.newPath },
      };
    case 'rename-folder':
      return {
        type: 'rename-folder',
        payload: { oldPath: change.oldPath, newPath: change.newPath },
      };
    case 'delete':
      return {
        type: 'delete-note',
        payload: { path: change.path },
      };
  }
}
