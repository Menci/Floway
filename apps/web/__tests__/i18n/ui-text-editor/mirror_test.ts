import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testing,
  isUiTextEditorEnabled,
  syncUiTextEditorPreference,
} from '../../../src/i18n/ui-text-editor/mirror';
import { stubLocalStorage } from '../../local-storage-stub';

stubLocalStorage();

describe('UI text editor preference mirror', () => {
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

  it('preserves the last mirror value across reload until a signed-in user overrides it', () => {
    window.localStorage.setItem(__testing.storageKey, '1');
    __testing.resetBootState();
    expect(isUiTextEditorEnabled()).toBe(true);

    expect(syncUiTextEditorPreference(true)).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    expect(syncUiTextEditorPreference(false)).toBe(true);
    expect(__testing.readStored()).toBe(false);
    expect(reload).toHaveBeenCalled();
  });
  it('does not reload when localStorage refuses the write', () => {
    const reload = vi.fn();
    __testing.setReloadHandler(reload);
    __testing.resetBootState(false);

    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    expect(syncUiTextEditorPreference(true)).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    setItem.mockRestore();
  });
});
