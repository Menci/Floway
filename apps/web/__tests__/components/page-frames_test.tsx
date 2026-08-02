import { act } from '@testing-library/react';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider, useOutlet } from 'react-router';
import { describe, expect, it } from 'vitest';

import { usePageFrames } from '../../src/components/page-frames';
import { pageNavigation } from '../../src/lib/page-navigation';
import { renderInApp } from '../render';

// A page is held on screen while it leaves, and it is held so that what the
// operator was looking at is what fades out. That only works while React keeps
// the page mounted across the navigation: a page that remounts on its way out
// resets every `useState` it holds to whatever its loader data said when the
// page was entered, and any effect keyed on that state runs again with the
// reset value -- which is how the API keys page came to forget, and unpersist,
// the key that had just been picked.
const Page = () => {
  const [picked, setPicked] = useState('none');
  return <button onClick={() => setPicked('second')} type="button">{picked}</button>;
};

const Shell = () => {
  const frames = usePageFrames(useOutlet(), 5_000);
  return <>{frames.map(frame => <div data-leaving={frame.leaving} key={frame.id}>{frame.node}</div>)}</>;
};

const renderRouter = () => {
  const router = createMemoryRouter([
    { path: '/', Component: Shell, children: [{ index: true, Component: Page }, { path: 'next', Component: Page }] },
  ], { initialEntries: ['/'] });
  return { router, ...renderInApp(<RouterProvider router={router} />) };
};

describe('page frames', () => {
  it('keeps the leaving page mounted with the state it was drawn with', async () => {
    const { router, getByRole, container } = renderRouter();

    await act(async () => { getByRole('button').click(); });
    expect(getByRole('button').textContent).toBe('second');
    const held = getByRole('button');

    await act(async () => { await router.navigate('/next', pageNavigation); });

    const leaving = container.querySelector('[data-leaving="true"]');
    expect(leaving?.querySelector('button')).toBe(held);
    expect(leaving?.textContent).toBe('second');
  });

  // A page carries the mark on its own entry and replaces that entry when it
  // restates its URL, so the mark alone would make a filter change look like an
  // arrival: a new frame, and with it the page remounted from its loader data.
  it('draws no new frame when the page rewrites the entry it is already on', async () => {
    const { router, container } = renderRouter();
    const currentButton = () => {
      const button = container.querySelector<HTMLButtonElement>('[data-leaving="false"] button');
      if (!button) throw new Error('the current frame drew no page');
      return button;
    };

    await act(async () => { await router.navigate('/next', pageNavigation); });
    await act(async () => { currentButton().click(); });
    const held = currentButton();

    await act(async () => { await router.navigate('/next?range=7d', { ...pageNavigation, replace: true }); });

    expect(container.querySelector('[data-leaving="true"]')).toBeNull();
    expect(currentButton()).toBe(held);
    expect(held.textContent).toBe('second');
  });
});
