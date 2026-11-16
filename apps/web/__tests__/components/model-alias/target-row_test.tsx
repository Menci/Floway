import { fireEvent, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { AliasTargetRow } from '../../../src/components/model-alias/target-row';
import { indexCatalog } from '../../../src/components/models/catalog-index';
import { i18n } from '../../../src/i18n';
import { catalogModel } from '../../api/model-fixture';
import { renderInApp } from '../../render';

test('model alias suggestions display catalog names and select routing ids', async () => {
  const onChange = vi.fn();
  renderInApp(<AliasTargetRow
    catalog={indexCatalog([catalogModel('kimi-k2.8-preview', { display_name: 'Kimi K2.8 Preview' })])}
    disabled={false}
    handleProps={{ 'data-reorder-handle': '0', disabled: true, disabledFocusable: false, onPointerDown: () => {} }}
    index={0}
    isSole
    itemProps={{}}
    kind="chat"
    onChange={onChange}
    onRemove={() => {}}
    target={{ target_model_id: '', rules: {} }}
    targetIds={['kimi-k2.8-preview']}
  />);
  fireEvent.click(screen.getByRole('combobox', { name: i18n.t('dashboard.modelAliases.target.modelId') }));
  const option = await screen.findByRole('option', { name: /Kimi K2.8 Preview/ });
  expect(option.textContent).toBe('Kimi K2.8 Previewkimi-k2.8-preview');
  fireEvent.click(option);
  expect(onChange).toHaveBeenLastCalledWith({ target_model_id: 'kimi-k2.8-preview', rules: {} });
});
