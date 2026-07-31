import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PricingEditor } from '../../../src/components/upstream-editor/pricing-editor';
import { fluentComponents } from '../../../src/fluent';
import '../../../src/i18n';
import { flowayLightTheme } from '../../../src/theme';

const { FluentProvider } = fluentComponents;

afterEach(cleanup);

describe('read-only pricing editor', () => {
  it('keeps one visible pricing rule selected', () => {
    const view = render(
      <FluentProvider theme={flowayLightTheme}>
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
        />
      </FluentProvider>,
    );

    const selected = view.container.querySelectorAll('[aria-selected="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toContain('Base');
  });
});
