import { describe, expect, it } from 'vitest';

import { streamEventsCopyText } from '../../../src/components/requests/stream-render';
import type { DumpStreamEvent } from '@floway-dev/gateway/browser';

const event = (frame: DumpStreamEvent['frame']): DumpStreamEvent => ({ frame, ts: 1 });

describe('GenerateContent bare errors', () => {
  const error = { error: { code: 500, status: 'INTERNAL', message: 'failure' } };
  it('copies the bare JSON error after normal SSE chunks', () => {
    const chunk = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'partial' }] } }] };
    expect(streamEventsCopyText('gemini-generate-content', [event({ type: 'event', event: chunk }), event({ type: 'event', event: error })])).toBe(`data: ${JSON.stringify(chunk)}\n\n${JSON.stringify(error)}`);
  });
});
