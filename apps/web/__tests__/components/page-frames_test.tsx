import { act, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider, useOutlet } from 'react-router';
import { describe, expect, it } from 'vitest';

import { usePageFrames } from '../../src/components/page-frames';
import { pageNavigation } from '../../src/lib/page-navigation';
import { PAGE_LEAVE_ANIMATION } from '../../src/winui/page-transition.css';
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
  const frames = usePageFrames(useOutlet());
  return <>{frames.map(frame => <div data-leaving={frame.leaving} key={frame.id} onAnimationEnd={frame.onAnimationEnd}>{frame.node}</div>)}</>;
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

  // A request for reduced motion clamps the fade to 0.01ms, so anything that
  // held the frame for the unclamped length would keep an invisible copy of the
  // page -- effects, polling and all -- mounted long after it had gone.
  it('drops the leaving page when its fade ends, whatever that fade lasted', async () => {
    const { router, container } = renderRouter();

    await act(async () => { await router.navigate('/next', pageNavigation); });
    const leaving = container.querySelector('[data-leaving="true"]');
    if (!leaving) throw new Error('the navigation drew no leaving frame');
    const page = leaving.querySelector('button');
    if (!page) throw new Error('the leaving frame drew no page');

    // A page inside the frame animating is not the frame leaving.
    await act(async () => { fireEvent.animationEnd(page, { animationName: PAGE_LEAVE_ANIMATION }); });
    expect(container.querySelector('[data-leaving="true"]')).toBe(leaving);

    await act(async () => { fireEvent.animationEnd(leaving, { animationName: PAGE_LEAVE_ANIMATION }); });
    expect(container.querySelector('[data-leaving="true"]')).toBeNull();
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
