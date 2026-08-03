import { act, createEvent, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { ChoiceGroup } from '../../../src/components/ui/choice-group';
import { TooltipIconButton } from '../../../src/components/ui/tooltip-icon-button';
import { renderInApp } from '../../render';

// A control that opens another page is an anchor, so the browser can act on it
// without the app: a middle click, a modified click and the context menu's own
// open-in-new-tab all need an address to read and a click the app leaves alone.
const EDITOR_PATH = '/dashboard/providers/upstreams/u1';

const renderRouter = (node: ReactNode) => {
  const router = createMemoryRouter([
    { path: '/', Component: () => node },
    { path: EDITOR_PATH, Component: () => <p>editor</p> },
  ], { initialEntries: ['/'] });
  return { router, ...renderInApp(<RouterProvider router={router} />) };
};

describe('addressed controls', () => {
  it('opens a page from an anchor and routes the plain click in place', async () => {
    const { router, getByRole } = renderRouter(
      <TooltipIconButton icon={<span />} label="Edit upstream" to={EDITOR_PATH} />,
    );

    const link = getByRole('link', { name: 'Edit upstream' });
    expect(link.getAttribute('href')).toBe(EDITOR_PATH);

    await act(async () => { fireEvent.click(link, { button: 0 }); });
    expect(router.state.location.pathname).toBe(EDITOR_PATH);
  });

  it('leaves a modified click to the browser', async () => {
    const { router, getByRole } = renderRouter(
      <TooltipIconButton icon={<span />} label="Edit upstream" to={EDITOR_PATH} />,
    );

    const link = getByRole('link', { name: 'Edit upstream' });
    const click = createEvent.click(link, { button: 0, ctrlKey: true });
    await act(async () => { fireEvent(link, click); });

    expect(click.defaultPrevented).toBe(false);
    expect(router.state.location.pathname).toBe('/');
  });

  it('addresses a choice whose page owns the transition, without navigating itself', async () => {
    const onChange = vi.fn();
    const { router, getByRole } = renderRouter(<ChoiceGroup
      ariaLabel="Range"
      items={[
        { value: 'today', label: 'Today', to: '?range=today' },
        { value: '7d', label: '7 days', to: '?range=7d' },
      ]}
      onChange={onChange}
      value="today"
    />);

    const sevenDays = getByRole('radio', { name: '7 days' });
    expect(sevenDays.getAttribute('href')).toBe('/?range=7d');

    await act(async () => { fireEvent.click(sevenDays, { button: 0 }); });
    expect(onChange).toHaveBeenCalledWith('7d');
    expect(router.state.location.search).toBe('');
  });
});
