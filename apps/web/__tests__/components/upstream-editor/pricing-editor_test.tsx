import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PricingEditor } from '../../../src/components/upstream-editor/pricing-editor';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

describe('read-only pricing editor', () => {
  it('keeps one visible pricing rule selected', () => {
    const view = renderInApp(
      <PricingEditor
        endpoints={{ chatCompletions: {} }}
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

  it('authors rerank search pricing on a mixed primary kind', () => {
    const onChange = vi.fn();
    renderInApp(
      <PricingEditor
        endpoints={{ embeddings: {}, rerank: {} }}
        onChange={onChange}
        readOnly={false}
        value={undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.setupPricing') }));
    fireEvent.change(screen.getByLabelText(/Searches \(\$\/1K searches\)/), { target: { value: '2' } });
    expect(onChange).toHaveBeenLastCalledWith({ entries: [{ rates: { rerank_searches: '0.002' } }] });
  });
});
