import { fireEvent, screen, waitFor } from '@testing-library/react';
import { StrictMode, useEffect, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NavSelectionIndicator } from '../../src/components/sidebar/nav-selection-indicator';
import { fluentComponents } from '../../src/fluent';
import { renderInApp } from '../render';

interface ScheduledAnimation {
  cancelled: boolean;
  cancel: () => void;
  addEventListener: () => void;
}

const ROW_HEIGHT = 36;
const ITEMS = ['home', 'keys', 'models'];
const OTHER_LIST_ITEMS = ['settings', 'sign out'];

let scheduled: ScheduledAnimation[] = [];

const stubAnimations = () => {
  scheduled = [];
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: () => {
      const animation: ScheduledAnimation = {
        addEventListener: () => {},
        cancel: () => { animation.cancelled = true; },
        cancelled: false,
      };
      scheduled.push(animation);
      return animation;
    },
    writable: true,
  });
};

// happy-dom lays nothing out, so every box measures zero and the indicator
// would read every selection change as a zero-length move it can skip.
const stubLayout = () => {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: function (this: HTMLElement): DOMRect {
      const item = this.dataset.navValue;
      const top = item === undefined ? 0 : ITEMS.indexOf(item) * ROW_HEIGHT;
      const height = item === undefined ? ROW_HEIGHT * ITEMS.length : ROW_HEIGHT;
      return { bottom: top + height, height, left: 0, right: 200, toJSON: () => ({}), top, width: 200, x: 0, y: top } as DOMRect;
    },
    writable: true,
  });
};

const stubReducedMotion = (reduce: boolean) => {
  window.matchMedia = vi.fn(() => ({ addEventListener: () => {}, matches: reduce, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
};

// The selection is driven from inside the tree because the indicator measures
// against a container it is rendered into, and re-rendering from the outside
// would remount that container along with the positions it has recorded.
const NavHarness = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedValue, setSelectedValue] = useState(ITEMS[0]);
  // The container is this component's own element, so its ref is still empty
  // while a child mounted in the same commit runs its layout effect.
  const [containerReady, setContainerReady] = useState(false);
  useEffect(() => setContainerReady(true), []);
  return <div ref={containerRef}>
    <div>
      {[...ITEMS, ...OTHER_LIST_ITEMS].map(item => <button
        aria-current={item === selectedValue ? 'page' : undefined}
        data-nav-value={ITEMS.includes(item) ? item : undefined}
        key={item}
        onClick={() => setSelectedValue(item)}
      >{item}</button>)}
    </div>
    {containerReady && <NavSelectionIndicator containerRef={containerRef} inset={4} otherListIs="below" selectedValue={selectedValue} />}
  </div>;
};

const select = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('nav selection indicator', () => {
  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, 'animate');
    Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect');
  });

  it('schedules no animation at all when reduced motion is preferred', () => {
    stubLayout();

    stubAnimations();
    stubReducedMotion(false);
    const moving = renderInApp(<StrictMode><NavHarness /></StrictMode>);
    select('models');
    expect(scheduled.length).toBeGreaterThan(0);
    moving.unmount();

    stubAnimations();
    stubReducedMotion(true);
    renderInApp(<StrictMode><NavHarness /></StrictMode>);
    select('models');
    expect(scheduled).toHaveLength(0);
  });

  it('cancels the outgoing animation it already scheduled instead of stacking a second one', () => {
    stubLayout();
    stubAnimations();
    stubReducedMotion(false);

    renderInApp(<StrictMode><NavHarness /></StrictMode>);
    select('settings');
    select('sign out');

    expect(scheduled.filter(animation => !animation.cancelled)).toHaveLength(1);
  });
});

describe('winui presence motion', () => {
  const { Button, Dialog, DialogBody, DialogSurface, DialogTitle } = fluentComponents;

  it('renders the dialog through the motion slot and keeps a caller-supplied motion callback', async () => {
    const onMotionFinish = vi.fn();
    const DialogHarness = () => {
      const [open, setOpen] = useState(true);
      return <Dialog open={open} surfaceMotion={{ onMotionFinish }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete the key</DialogTitle>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
          </DialogBody>
        </DialogSurface>
      </Dialog>;
    };

    renderInApp(<DialogHarness />);
    await screen.findByRole('dialog', { name: 'Delete the key' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onMotionFinish).toHaveBeenCalled());
  });
});
