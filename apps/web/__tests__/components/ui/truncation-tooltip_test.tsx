import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TruncationTooltip } from '../../../src/components/ui/truncation-tooltip';
import { stubFontLoading } from '../../font-loading-stub';
import { renderInApp } from '../../render';
import { advance, settle } from '../../settle';

// happy-dom lays nothing out, so both measurements come from the element under
// test: a trigger declares the box it was given and the text it painted into
// it, which is exactly what a browser reports through these two properties.
const stubTextMetrics = (): void => {
  const originals = (['clientWidth', 'scrollWidth'] as const)
    .map(property => [property, Object.getOwnPropertyDescriptor(HTMLElement.prototype, property)] as const);

  beforeEach(() => {
    for (const [property] of originals) {
      Object.defineProperty(HTMLElement.prototype, property, {
        configurable: true,
        get(this: HTMLElement) { return Number(this.dataset[property] ?? 0); },
      });
    }
  });

  afterEach(() => {
    for (const [property, descriptor] of originals) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, property);
    }
  });
};

const Trigger = ({ clientWidth, content, scrollWidth, text }: {
  clientWidth: number;
  content: string;
  scrollWidth: number;
  text?: string;
}) => (
  <TruncationTooltip content={content} relationship="label">
    {measureRef => (
      <span data-client-width={clientWidth} data-scroll-width={scrollWidth} ref={measureRef} tabIndex={0}>
        {text ?? content}
      </span>
    )}
  </TruncationTooltip>
);

// Fluent opens on a delay it owns, so a hover is the pointer plus that delay.
const hover = async (trigger: HTMLElement) => {
  fireEvent.pointerEnter(trigger);
  await advance(1000);
};

describe('a tooltip restoring text its trigger cannot show', () => {
  stubFontLoading();
  stubTextMetrics();

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('stays away from a label the trigger shows in full', async () => {
    renderInApp(<Trigger clientWidth={120} content="Copilot" scrollWidth={120} />);
    await settle();

    await hover(screen.getByText('Copilot'));

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('restores a label the trigger clips', async () => {
    renderInApp(<Trigger clientWidth={120} content="Claude Code" scrollWidth={186} />);
    await settle();

    await hover(screen.getByText('Claude Code'));

    expect(screen.getByRole('tooltip').textContent).toBe('Claude Code');
  });

  it('names the trigger either way, so suppressing the tooltip does not unname it', async () => {
    const view = renderInApp(<Trigger clientWidth={120} content="Copilot" scrollWidth={120} />);
    await settle();
    expect(screen.getByText('Copilot').getAttribute('aria-label')).toBe('Copilot');

    view.unmount();
    renderInApp(<Trigger clientWidth={120} content="Copilot" scrollWidth={186} />);
    await settle();
    expect(screen.getByText('Copilot').getAttribute('aria-label')).toBe('Copilot');
  });

  it('restores text elided before it ever reached the box', async () => {
    renderInApp(<Trigger
      clientWidth={120}
      content="7f3c9a20-1b44-4e0d-9f21-2c6b8ad51e77"
      scrollWidth={120}
      text="7f3c9a20…51e77"
    />);
    await settle();

    await hover(screen.getByText('7f3c9a20…51e77'));

    expect(screen.getByRole('tooltip').textContent).toBe('7f3c9a20-1b44-4e0d-9f21-2c6b8ad51e77');
  });

  it('re-measures when the text changes without the box changing', async () => {
    const view = renderInApp(<Trigger clientWidth={120} content="Copilot" scrollWidth={120} />);
    await settle();

    view.rerender(<Trigger clientWidth={120} content="Claude Code on a long account" scrollWidth={420} />);
    await settle();
    await hover(screen.getByText('Claude Code on a long account'));

    expect(screen.getByRole('tooltip').textContent).toBe('Claude Code on a long account');
  });

  // A fractional layout reports a pixel of scrollable overflow on text that is
  // fully painted, which is the whole of the tolerance the measurement carries.
  it('treats a pixel of overflow as text that fits', async () => {
    renderInApp(<Trigger clientWidth={120} content="Copilot" scrollWidth={121} />);
    await settle();

    await hover(screen.getByText('Copilot'));

    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
