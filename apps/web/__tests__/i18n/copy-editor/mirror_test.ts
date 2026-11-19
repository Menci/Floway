import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testing,
  isCopyEditorEnabled,
  readCopyEditorMirror,
  syncCopyEditorPreference,
} from '../../../src/i18n/copy-editor/mirror';
import { stubLocalStorage } from '../../local-storage-stub';

stubLocalStorage();

describe('copy editor preference mirror', () => {
  const reload = vi.fn();

  beforeEach(() => {
    window.localStorage.clear();
    reload.mockReset();
    __testing.setReloadHandler(reload);
    __testing.resetBootState(false);
  });

  afterEach(() => {
    __testing.resetBootState(false);
  });

  it('updates the local mirror and triggers reload when preference diverges from boot state', () => {
    expect(isCopyEditorEnabled()).toBe(false);
    expect(syncCopyEditorPreference(false)).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    expect(syncCopyEditorPreference(true)).toBe(true);
    expect(readCopyEditorMirror()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('preserves the last mirror value across reload until a signed-in user overrides it', () => {
    window.localStorage.setItem(__testing.storageKey, '1');
    __testing.resetBootState();
    expect(isCopyEditorEnabled()).toBe(true);

    // Same preference does not reload.
    expect(syncCopyEditorPreference(true)).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    // Signing into an account with copyEditor disabled updates mirror and reloads.
    expect(syncCopyEditorPreference(false)).toBe(true);
    expect(readCopyEditorMirror()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
