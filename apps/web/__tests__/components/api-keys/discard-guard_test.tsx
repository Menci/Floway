import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ApiKey } from '../../../src/api/types';
import { KeyDialog } from '../../../src/components/api-keys/editor';
import { RotateKeyDialog } from '../../../src/components/api-keys/rotate-dialog';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

// A key dialog holds a name, a key of the operator's own, an upstream selection
// and two retention windows, none of which exist anywhere else while the dialog
// is open. Cancel, Esc and the scrim all reach the same request, so what is
// asserted here is the question being asked at all.
const apiKey: ApiKey = {
  id: 'first',
  name: 'First key',
  key: 'sk-first',
  upstream_ids: null,
  created_at: '2026-01-01T00:00:00.000Z',
  last_used_at: null,
  dump_retention_seconds: null,
  responses_retention_seconds: 0,
};

const renderKeyDialog = (onOpenChange: (open: boolean) => void) => renderInApp(
  <OutcomeToastProvider>
    <KeyDialog
      mode="edit"
      apiKey={apiKey}
      models={[]}
      onOpenChange={onOpenChange}
      onSaved={vi.fn()}
      open
      upstreams={[]}
      userUpstreamIds={null}
    />
  </OutcomeToastProvider>,
);

const renderRotateDialog = (onOpenChange: (open: boolean) => void) => renderInApp(
  <OutcomeToastProvider>
    <RotateKeyDialog apiKey={apiKey} onOpenChange={onOpenChange} onSaved={vi.fn()} open />
  </OutcomeToastProvider>,
);

const cancel = async () => {
  const button = screen.getAllByRole('button', { name: i18n.t('common.cancel') }).at(0);
  await act(async () => { button?.click(); });
};

const discardPrompt = () => screen.queryByText(i18n.t('common.discard.message'));

describe('API key dialogs guard a draft', () => {
  it('asks before dropping an edited name', async () => {
    const onOpenChange = vi.fn();
    const view = renderKeyDialog(onOpenChange);
    const name = view.getByDisplayValue('First key');

    await act(async () => { fireEvent.change(name, { target: { value: 'Renamed key' } }); });
    await cancel();

    expect(discardPrompt()).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('closes an untouched dialog without a question', async () => {
    const onOpenChange = vi.fn();
    renderKeyDialog(onOpenChange);

    await cancel();

    expect(discardPrompt()).toBeNull();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('asks before dropping a key the operator typed for a rotation', async () => {
    const onOpenChange = vi.fn();
    const view = renderRotateDialog(onOpenChange);

    await act(async () => {
      view.getByRole('radio', { name: i18n.t('dashboard.apiKeys.source.custom') }).click();
    });
    await act(async () => {
      fireEvent.change(
        view.getByPlaceholderText(i18n.t('dashboard.apiKeys.form.customKeyPlaceholder')),
        { target: { value: 'sk-typed' } },
      );
    });
    await cancel();

    expect(discardPrompt()).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('closes an untouched rotation without a question', async () => {
    const onOpenChange = vi.fn();
    renderRotateDialog(onOpenChange);

    await cancel();

    expect(discardPrompt()).toBeNull();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
