import { describe, expect, it, vi } from 'vitest';

import { PricingEditor } from '../../../src/components/upstream-editor/pricing-editor';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

describe('read-only pricing editor', () => {
  it('keeps one visible pricing rule selected', () => {
    const view = renderInApp(
      <PricingEditor
        kind="chat"
        onChange={vi.fn()}
        readOnly
        value={{
          entries: [
            { rates: { input_tokens: '0.000001' } },
            { selector: { serviceTier: 'priority' }, rates: { input_tokens: '0.000002' } },
          ],
        }}
      />,
    );

    const selected = view.container.querySelectorAll('[aria-selected="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toContain(i18n.t('dashboard.upstreamEditor.models.pricingBase'));
  });
});
