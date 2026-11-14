import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RenderedEventList, type RenderedEvent } from '../../../src/components/requests/events';
import { renderInApp } from '../../render';

const events: RenderedEvent[] = Array.from({ length: 120 }, (_, i) => ({
  timestamp: i * 15,
  event: null,
  parseError: null,
  text: JSON.stringify({
    type: 'event', event: {
      id: 'demo', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { content: i === 99 ? 'needle <script>alert(1)</script>' : `chunk ${i + 1}` }, finish_reason: null }],
    },
  }, null, 2),
}));
events.push({ timestamp: 1800, event: 'done', parseError: null, text: JSON.stringify({ type: 'done' }, null, 2) });

const renderEvents = () => renderInApp(<RenderedEventList events={events} copyText={events.map(event => event.text).join('\n')} toolbarStart={<span>View selector</span>} />);

describe('per-event view', () => {
  it('renders separate highlighted JSON blocks and collapses each event independently', () => {
    const view = renderEvents();
    expect(screen.getByRole('button', { name: '#1 Event' }).getAttribute('aria-expanded')).toBe('true');
    const first = screen.getByRole('button', { name: '#1 Event' }).closest('[role="listitem"]')!;
    expect(first.querySelector('.token.property')).not.toBeNull();
    expect(within(first as HTMLElement).getByText('+0.000ms')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '#1 Event' }));
    expect(first.querySelector('pre')).toBeNull();
    expect(screen.getByRole('button', { name: '#2 Event' }).getAttribute('aria-expanded')).toBe('true');
    expect(view.container.querySelectorAll('[role="listitem"]').length).toBeLessThan(events.length);
  });

  it('searches offscreen events, preserves their numbering and safely highlights payload text', () => {
    const view = renderEvents();
    fireEvent.click(screen.getByRole('button', { name: 'Search events' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search events' }), { target: { value: 'needle' } });
    expect(screen.getByRole('button', { name: '#100 Event' })).toBeTruthy();
    expect(screen.getByText('1 / 121')).toBeTruthy();
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.querySelector('code')?.textContent).toContain('<script>alert(1)</script>');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search events' }), { target: { value: 'unmatched' } });
    expect(screen.getByText('No matching events')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search events' }), { target: { value: 'done' } });
    expect(screen.getByRole('button', { name: '#121 done' })).toBeTruthy();
    expect(screen.queryByText('Invalid JSON')).toBeNull();
  });
});
