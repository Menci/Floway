import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AliasDialog } from '../../../src/components/model-alias/dialog';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';
import type { ModelAlias } from '@floway-dev/protocols/browser';

const source: ModelAlias = {
  id: 'source', name: 'source', kind: 'chat', selection: 'first-available',
  display_name: null, visible_in_models_list: true,
  targets: [{ target_model_id: 'gpt-4o', rules: {} }],
  announced_metadata: null, sort_order: 0,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
};

describe('model alias discard dialog focus', () => {
  it('returns focus and editing to the copied alias form after continuing', async () => {
    renderInApp(<OutcomeToastProvider><AliasDialog
      aliases={[source]} mode="copy" models={[]} onOpenChange={vi.fn()} open
      onSaved={vi.fn(async () => {})} record={source}
    /></OutcomeToastProvider>);
    const name = screen.getByLabelText(i18n.t('dashboard.modelAliases.form.name'));
    // Let the parent modal finish its initial autofocus before opening a nested modal.
    await waitFor(() => expect(document.activeElement).toBe(name.closest('[role="dialog"]')), { timeout: 5000 });
    name.focus();

    await act(async () => { fireEvent.change(name, { target: { value: 'edited-copy' } }); });
    await act(async () => { screen.getByRole('button', { name: i18n.t('common.cancel') }).click(); });
    const keepEditing = await screen.findByRole('button', { name: i18n.t('common.discard.keep') }, { timeout: 5000 });
    await act(async () => { keepEditing.click(); });

    await waitFor(() => expect(document.activeElement).toBe(name), { timeout: 5000 });
    await act(async () => { fireEvent.change(name, { target: { value: 'editable-again' } }); });
    expect((name as HTMLInputElement).value).toBe('editable-again');
    expect(name.closest('[role="dialog"]')?.getAttribute('aria-hidden')).not.toBe('true');
    expect(name.closest('[role="dialog"]')?.hasAttribute('inert')).toBe(false);
  }, 15000);
});
