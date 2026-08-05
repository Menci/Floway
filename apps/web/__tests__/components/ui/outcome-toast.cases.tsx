import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { OutcomeToastProvider, useOutcomeToasts } from '../../../src/components/ui/outcome-toast';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';
import { settle } from '../../settle';

const Harness = () => {
  const toasts = useOutcomeToasts();
  return <button onClick={() => toasts.succeed('Saved')} type="button">save</button>;
};

describe('outcome toast dismissal', () => {
  it('offers a semantic dismiss button', async () => {
    renderInApp(<OutcomeToastProvider><Harness /></OutcomeToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await settle();

    const dismiss = screen.getByRole('button', { name: i18n.t('common.dismiss') });
    fireEvent.click(dismiss);
    await settle();

    expect(screen.queryByRole('listitem')).toBeNull();
  });
});
