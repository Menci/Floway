import { describe, expect, it } from 'vitest';

import { detectCollectKind, streamEndedCleanly, streamEventsCopyText } from '../../../src/components/requests/stream-render';
import type { DumpStreamEvent } from '@floway-dev/gateway/browser';

const event = (frame: DumpStreamEvent['frame']): DumpStreamEvent => ({ frame, ts: 1 });

describe('captured stream completion', () => {
  it('recognizes the protocol done frame', () => {
    expect(streamEndedCleanly([
      event({ type: 'event', event: { value: 'partial' } }),
      event({ type: 'done' }),
    ])).toBe(true);
  });
});

describe('detectCollectKind', () => {
  it('recognizes a Gemini turn under either prefix', () => {
    expect(detectCollectKind('/v1beta/models/gemini-2.5-pro:generateContent')).toBe('gemini-generate-content');
    expect(detectCollectKind('/v1/models/gemini-2.5-pro:generateContent')).toBe('gemini-generate-content');
    expect(detectCollectKind('/v1/models/gemini-2.5-pro:streamGenerateContent?alt=sse')).toBe('gemini-generate-content');
    expect(detectCollectKind('/v1/models/gemini-2.5-pro:countTokens')).toBe('gemini-generate-content');
  });
});

describe('GenerateContent bare errors', () => {
  const error = { error: { code: 500, status: 'INTERNAL', message: 'failure' } };
  it('copies the bare JSON error after normal SSE chunks', () => {
    const chunk = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'partial' }] } }] };
    expect(streamEventsCopyText('gemini-generate-content', [event({ type: 'event', event: chunk }), event({ type: 'event', event: error })])).toBe(`data: ${JSON.stringify(chunk)}\n\n${JSON.stringify(error)}`);
  });
});
