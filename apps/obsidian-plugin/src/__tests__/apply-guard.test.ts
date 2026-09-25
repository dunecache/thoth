import { describe, expect, it } from 'vitest';

import { createApplyGuard } from '../apply-guard.js';

describe('createApplyGuard', () => {
  it('suppresses the event for a write it just made', () => {
    const guard = createApplyGuard();
    guard.recordText('notes/a.md', 'server content');

    expect(guard.consume('notes/a.md', 'server content')).toBe(true);
    // The record is consumed, so the next event is a genuine change.
    expect(guard.consume('notes/a.md', 'server content')).toBe(false);
  });

  it('does not suppress a user edit that follows the applier write', () => {
    const guard = createApplyGuard();
    guard.recordText('notes/a.md', 'server content');

    // The user typed before the vault event surfaced.
    expect(guard.consume('notes/a.md', 'server content plus my edit')).toBe(
      false
    );
    expect(guard.pending).toBe(1);
  });

  it('does not suppress an unrelated path during a sync', () => {
    const guard = createApplyGuard();
    guard.recordText('notes/a.md', 'server content');

    // The bug this replaces: any local edit during a sync was discarded.
    expect(guard.consume('notes/b.md', 'my own edit')).toBe(false);
  });

  it('counts repeated writes so each produces a suppressed event', () => {
    const guard = createApplyGuard();
    guard.recordText('notes/a.md', 'first');
    guard.recordText('notes/a.md', 'second');

    // The vault now holds "second", so both modify events carry that
    // content and both are self-inflicted.
    expect(guard.consume('notes/a.md', 'second')).toBe(true);
    expect(guard.consume('notes/a.md', 'second')).toBe(true);
    expect(guard.pending).toBe(0);
  });

  it('matches binary writes by hash', () => {
    const guard = createApplyGuard();
    guard.recordBinary('img/a.png', 'abc123');

    expect(guard.consume('img/a.png', 'sha256:abc123')).toBe(true);
  });

  it('does not match binary writes against a different hash', () => {
    const guard = createApplyGuard();
    guard.recordBinary('img/a.png', 'abc123');

    expect(guard.consume('img/a.png', 'sha256:different')).toBe(false);
  });

  it('suppresses a path-only record regardless of fingerprint', () => {
    const guard = createApplyGuard();
    guard.recordPath('notes/gone.md');

    expect(guard.consume('notes/gone.md')).toBe(true);
  });

  it('does not match a path-only record against unexpected content', () => {
    const guard = createApplyGuard();
    guard.recordPath('notes/renamed.md');

    // A rename records both paths; a later create on the new path is real.
    guard.recordPath('notes/renamed.md');
    expect(guard.consume('notes/renamed.md', 'fresh content')).toBe(true);
  });

  it('refuses to match a fingerprint when the file is gone', () => {
    const guard = createApplyGuard();
    guard.recordText('notes/a.md', 'server content');

    // A content-bearing record must not be satisfied by a bare path lookup.
    expect(guard.consume('notes/a.md')).toBe(false);
  });

  it('clears pending records on reset', () => {
    const guard = createApplyGuard();
    guard.recordText('notes/a.md', 'server content');
    expect(guard.pending).toBe(1);

    guard.reset();
    expect(guard.pending).toBe(0);
    expect(guard.consume('notes/a.md', 'server content')).toBe(false);
  });
});
