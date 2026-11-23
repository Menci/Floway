import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EventList } from '../../../src/components/requests/events';
import type { StreamFrameEntry } from '../../../src/components/requests/stream-render';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const events: StreamFrameEntry[] = Array.from({ length: 120 }, (_, i) => ({
  ts: i * 15,
  ...(i === 0 ? {} : { deltaMs: 15 }),
  frame: {
    type: 'event', event: {
      id: 'demo', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{  index: 0, delta: { content: i === 99 ? 'needle <script>alert(1)</script>' : `chunk ${i + 1}` }, finish_reason: null }],
    },
  },
}));
events.push({ ts: 1800, frame: { type: 'done' } });

const renderEvents = () => renderInApp(<EventList events={events} kind="openai-chat-completions" toolbarStart={<span>View selector</span>} />);

describe('per-event view', () => {

  it('searches offscreen events, preserves their numbering and safely highlights payload text', () => {
    const view = renderEvents();
    fireEvent.click(screen.getByRole('button', { name: 'Search events' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search events' }), { target: { value: 'needle' } });
    expect(screen.getByRole('button', { name: '#100 Event' })).toBeTruthy();
    expect(screen.getByText('1 / 121')).toBeTruthy();
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.querySelector('code')?.textContent).toContain('<script>alert(1)</script>');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search events' }), { target: { value: 'unmatched' } });
    expect(screen.getByText(i18n.t('requests.noEventMatches'))).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search events' }), { target: { value: '[DONE]' } });
    expect(screen.getByRole('button', { name: '#121 [DONE]' })).toBeTruthy();
    expect(screen.queryByText(i18n.t('requests.eventParseError'))).toBeNull();
  });

  it('shows the delta beside the absolute timestamp', () => {
    renderInApp(<EventList events={events.slice(0, 2)} kind="openai-chat-completions" toolbarStart={<span>View selector</span>} />);
    expect(screen.getByText('Δ15ms')).toBeTruthy();
  });
});
