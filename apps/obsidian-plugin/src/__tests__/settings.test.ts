import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  parseSettings,
  withSetting,
  type ThothSettings,
} from '../settings.js';

describe('parseSettings', () => {
  it('returns defaults for undefined data', () => {
    expect(parseSettings(undefined)).toEqual({ ...DEFAULT_SETTINGS });
  });

  it('returns defaults for non-object data', () => {
    expect(parseSettings('nope')).toEqual({ ...DEFAULT_SETTINGS });
    expect(parseSettings(42)).toEqual({ ...DEFAULT_SETTINGS });
    expect(parseSettings(['a'])).toEqual({ ...DEFAULT_SETTINGS });
    expect(parseSettings(null)).toEqual({ ...DEFAULT_SETTINGS });
  });

  it('merges partial data with defaults', () => {
    const settings = parseSettings({ serverUrl: 'https://sync.example.com' });
    expect(settings.serverUrl).toBe('https://sync.example.com');
    expect(settings.vaultId).toBe('');
    expect(settings.apiKey).toBe('');
  });

  it('ignores non-string field values', () => {
    expect(parseSettings({ serverUrl: 123, vaultId: true })).toEqual({
      ...DEFAULT_SETTINGS,
    });
  });

  it('parses lastVaultIds and normalizes', () => {
    expect(parseSettings({ lastVaultIds: ['a', 'b', 'a'] }).lastVaultIds).toEqual(['a', 'b']);
    expect(parseSettings({ lastVaultIds: 'nope' }).lastVaultIds).toEqual([]);
  });

  it('handles syncedExtensions fallback', () => {
    expect(parseSettings({ syncedExtensions: [] }).syncedExtensions).toEqual(['md', 'base']);
    expect(parseSettings({ syncedExtensions: ['TXT', '.md', ''] }).syncedExtensions).toEqual(['txt', 'md']);
  });
});

describe('withSetting', () => {
  it('returns a new settings object with one field replaced', () => {
    const base: ThothSettings = { ...DEFAULT_SETTINGS };
    const next = withSetting(base, 'serverUrl', 'https://x');
    expect(next.serverUrl).toBe('https://x');
    expect(base.serverUrl).toBe('');
  });
});
