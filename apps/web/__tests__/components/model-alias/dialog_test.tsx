import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AliasDialog } from '../../../src/components/model-alias/dialog';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { i18n, setLanguage } from '../../../src/i18n';
import { renderInApp } from '../../render';
import type { ModelAlias } from '@floway-dev/protocols/common';

const source: ModelAlias = {
  id: 'alias-source', name: 'source', kind: 'chat', selection: 'first-available', display_name: null,
  visible_in_models_list: true, targets: [{ target_model_id: 'model-a', rules: {} }], announced_metadata: null,
  sort_order: 0, created_at: '2026-01-01', updated_at: '2026-01-01',
};

const renderCopy = (aliases: readonly ModelAlias[] = [source]) => renderInApp(
  <OutcomeToastProvider>
    <AliasDialog
      aliases={aliases}
      mode="copy"
      models={null}
      onOpenChange={() => undefined}
      onSaved={async () => undefined}
      open
      record={source}
    />
  </OutcomeToastProvider>,
);

afterEach(async () => {
  await setLanguage('en');
});

describe('model alias copy dialog', () => {
  it.each(['en', 'zh-Hans'] as const)('starts with the same ASCII ID in %s', async language => {
    await setLanguage(language);
    renderCopy();

    const nameInput = screen.getByRole<HTMLInputElement>('textbox', { name: i18n.t('dashboard.modelAliases.form.name') });
    expect(nameInput.value).toBe('source-copy');
  });

  it('chooses the first available numeric suffix when copied IDs already exist', async () => {
    await setLanguage('en');
    renderCopy([
      source,
      { ...source, id: 'alias-copy-1', name: 'source-copy' },
      { ...source, id: 'alias-copy-2', name: 'source-copy-2' },
    ]);

    const nameInput = screen.getByRole<HTMLInputElement>('textbox', { name: i18n.t('dashboard.modelAliases.form.name') });
    expect(nameInput.value).toBe('source-copy-3');
  });
});
