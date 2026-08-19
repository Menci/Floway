import { screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { DocumentTitleSync } from '../../src/components/document-title-sync';
import { FlowayLogo } from '../../src/components/logo';
import { SiteSettingsProvider } from '../../src/components/site-settings-context';
import { renderInApp } from '../render';

afterEach(() => {
  document.title = '';
});

describe('site branding outlets', () => {
  it('changes the wordmark without replacing its mark', () => {
    const view = renderInApp(<>
      <FlowayLogo />
      <FlowayLogo name="My Gateway" />
    </>);

    expect(screen.getByText('Floway')).toBeTruthy();
    expect(screen.getByText('My Gateway')).toBeTruthy();
    const marks = [...view.container.querySelectorAll('img')];
    expect(marks).toHaveLength(2);
    expect(marks[0].getAttribute('src')).toBe(marks[1].getAttribute('src'));
  });

  it('uses the configured name in the browser title', async () => {
    const router = createMemoryRouter([{
      path: '*',
      Component: () => <SiteSettingsProvider value={{ name: 'My Gateway' }}><DocumentTitleSync /></SiteSettingsProvider>,
    }], { initialEntries: ['/dashboard'] });

    renderInApp(<RouterProvider router={router} />);

    await waitFor(() => expect(document.title).toBe('Dashboard | My Gateway'));
  });
});
