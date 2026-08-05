import { describe, expect, it } from 'vitest';

import { renderStreamEvents, streamEndedCleanly } from '../../../src/components/requests/stream-render';
import type { DumpStreamEvent } from '@floway-dev/gateway/dump-types';

const event = (frame: DumpStreamEvent['frame']): DumpStreamEvent => ({ frame, ts: 1 });

describe('captured stream completion', () => {
  it('recognizes the protocol done frame', () => {
    expect(streamEndedCleanly([
      event({ type: 'event', event: { value: 'partial' } }),
      event({ type: 'done' }),
    ])).toBe(true);
  });

  it('marks a recording with no done frame as incomplete', () => {
    expect(streamEndedCleanly([
      event({ type: 'event', event: { value: 'partial' } }),
    ])).toBe(false);
  });

  it.each(['chat-completions', 'completions', 'responses'] as const)(
    'renders the %s terminal sentinel as protocol text rather than a JSON failure',
    kind => {
      expect(renderStreamEvents(kind, [event({ type: 'done' })])).toEqual([{
        event: null,
        text: '[DONE]',
        isJson: false,
        parseError: null,
        timestamp: 1,
      }]);
    },
  );
});
