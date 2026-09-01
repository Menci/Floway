import { describe, expect, it } from 'vitest';

import { collectKindFromTargetApi, streamEndedCleanly } from '../../../src/components/requests/stream-render';
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

// The upstream (pre-translation) view dispatches its serializer by the TARGET
// protocol the inner attempt spoke, not by the client path (which names the
// source protocol). `collectKindFromTargetApi` mirrors `detectCollectKind`
// for that purpose; null on native turns (no targetApi) and unknown values.
describe('collectKindFromTargetApi', () => {
  it('maps each ChatTargetApi to its CollectKind', () => {
    expect(collectKindFromTargetApi('anthropicMessages')).toBe('anthropic-messages');
    expect(collectKindFromTargetApi('openaiResponses')).toBe('openai-responses');
    expect(collectKindFromTargetApi('openaiChatCompletions')).toBe('openai-chat-completions');
  });

  it('returns null for absent or unknown targetApi (native turns)', () => {
    expect(collectKindFromTargetApi(null)).toBeNull();
    expect(collectKindFromTargetApi(undefined)).toBeNull();
    expect(collectKindFromTargetApi('unknown')).toBeNull();
  });
});
