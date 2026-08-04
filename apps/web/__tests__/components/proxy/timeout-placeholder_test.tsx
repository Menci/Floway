import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_DIAL_TIMEOUT_SECONDS, defaultsFor } from '../../../src/components/proxy/config';
import { ProxyForm } from '../../../src/components/proxy/form';
import { formatNumber } from '../../../src/lib/format-number';
import { renderInApp } from '../../render';

const renderForm = () => renderInApp(
  <ProxyForm
    config={defaultsFor('http', { host: '', port: 0, name: '' })}
    dialTimeoutInput=""
    errors={{}}
    formName=""
    onConfigChange={vi.fn()}
    onDialTimeoutChange={vi.fn()}
    onKindChange={vi.fn()}
    onNameChange={vi.fn()}
    onPortChange={vi.fn()}
    onUrlChange={vi.fn()}
    urlInput=""
  />,
);

describe('proxy dial timeout placeholder', () => {
  // The dial timeout is the one field of this form whose placeholder carries a
  // number, and i18n/number-format.ts throws on a number that reaches a
  // placeholder naming no format. That throw is a render error: it took the
  // whole page down to the error boundary rather than showing a bad label.
  it('names the default the field falls back to', () => {
    const view = renderForm();

    expect(view.container.innerHTML).toContain(formatNumber(DEFAULT_DIAL_TIMEOUT_SECONDS, 'en'));
  });
});
