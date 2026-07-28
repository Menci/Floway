import { describe, expect, it } from 'vitest';

import { streamEndedCleanly } from '../../../src/components/requests/stream-render';
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
});
