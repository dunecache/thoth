/**
 * Tracks the writes the sync applier makes to the vault.
 *
 * Applying server state produces vault events indistinguishable from user
 * edits. Suppressing them with a single "sync in progress" flag also
 * discards genuine edits made while the sync runs, because the flag stays
 * set for the whole cycle — a keystroke during a sync was lost forever.
 *
 * The guard instead records the fingerprint of each write the applier
 * performs, keyed by path. A vault event is treated as self-inflicted only
 * when the file still holds exactly what was written, so an edit to the
 * same path that lands afterwards is still queued.
 *
 * Entries are counted rather than flagged, so a path written twice
 * suppresses two events and an event whose content no longer matches is
 * never suppressed.
 */

export interface ApplyGuard {
  /** Records a text write. */
  recordText(path: string, content: string): void;
  /** Records a binary write by content hash. */
  recordBinary(path: string, hash: string): void;
  /**
   * Records a write whose resulting content cannot be read back, such as a
   * delete or a rename. Suppresses the next event for the path regardless
   * of fingerprint.
   */
  recordPath(path: string): void;
  /**
   * Records a folder rename and the descendant paths it moves.
   *
   * A folder rename moves a whole subtree, and Obsidian emits a rename event
   * for the folder *and* for every descendant file. Exact-path matching
   * suppressed only the folder's own event, so each descendant event looked
   * like a user edit and was queued — turning one applied rename into a burst
   * of redundant operations sent back to the server, where the engine had
   * already moved them and rejected each as `NOTE_NOT_FOUND`.
   *
   * `descendants` must be the paths actually moved. Counting them keeps the
   * existing one-record-per-event contract, so no real edit is swallowed by a
   * blanket prefix rule; the records lapse at the next `reset()` regardless.
   */
  recordFolderRename(
    oldPath: string,
    newPath: string,
    descendants: readonly string[]
  ): void;
  /**
   * Consumes a pending record for `path` and reports whether the event came
   * from the applier. `fingerprint` is the content the vault event carries;
   * omit it when the file no longer exists.
   */
  consume(path: string, fingerprint?: string): boolean;
  /** Drops every pending record. Called at the start of each sync. */
  reset(): void;
  /** Number of writes still awaiting their vault event. */
  readonly pending: number;
}

const BINARY_PREFIX = 'sha256:';

export function createApplyGuard(): ApplyGuard {
  const pending = new Map<string, { count: number; fingerprint: string }>();

  const record = (path: string, fingerprint: string): void => {
    const existing = pending.get(path);
    if (existing) {
      existing.count += 1;
      existing.fingerprint = fingerprint;
      return;
    }
    pending.set(path, { count: 1, fingerprint });
  };

  return {
    recordText: (path, content) => {
      record(path, content);
    },
    recordBinary: (path, hash) => {
      record(path, `${BINARY_PREFIX}${hash}`);
    },
    recordPath: (path) => {
      // An empty sentinel never equals a real fingerprint, so a later event
      // that does carry content is judged on that content instead.
      record(path, '');
    },
    recordFolderRename: (oldPath, newPath, descendants) => {
      record(oldPath, '');
      record(newPath, '');
      for (const path of descendants) {
        record(path, '');
      }
    },
    consume: (path, fingerprint) => {
      const existing = pending.get(path);
      if (!existing) {
        return false;
      }
      if (existing.fingerprint === '') {
        // Path-only record: matches regardless of fingerprint.
      } else if (fingerprint === undefined) {
        return false;
      } else if (existing.fingerprint !== fingerprint) {
        return false;
      }
      existing.count -= 1;
      if (existing.count <= 0) {
        pending.delete(path);
      }
      return true;
    },
    reset: () => {
      pending.clear();
    },
    get pending(): number {
      let total = 0;
      for (const entry of pending.values()) {
        total += entry.count;
      }
      return total;
    },
  };
}
