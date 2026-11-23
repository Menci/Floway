import { test } from 'vitest';

import { normalizeExclusiveCachedTokens } from '../../../../../src/data-plane/chat/openai-responses/stages/normalize-exclusive-cached-tokens.ts';
import { driveChatStages } from '../../shared/drive-stages.ts';
import { chatUpstream } from '../../shared/fixture.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals } from '@floway-dev/test-utils';

// Same accounting as the Charm Hyper OpenAI Chat Completions capture, in OpenAI Responses
// field names: 479 + 13312 + 373 = 14164, so total_tokens witnesses it.
const exclusiveUsage = (): NonNullable<OpenAIResponsesResultEx['usage']> => ({
  input_tokens: 479,
  output_tokens: 373,
  total_tokens: 14164,
  input_tokens_details: { cached_tokens: 13312 },
});

const completedEvent = (usage: NonNullable<OpenAIResponsesResultEx['usage']>): OpenAIResponsesStreamEventEx => ({
  type: 'response.completed',
  sequence_number: 0,
  response: {
    id: 'resp_test',
    object: 'response',
    model: 'test-model',
    status: 'completed',
    output: [],
    error: null,
    incomplete_details: null,
    usage,
  },
});

const run = async (usage: NonNullable<OpenAIResponsesResultEx['usage']>) => {
  const { candidate } = chatUpstream({ flags: ['usage-exclusive-cached-tokens'], endpoints: { openaiResponses: {} } });
  const result = await driveChatStages([normalizeExclusiveCachedTokens], { 'route.candidate': candidate }, {
    key: 'response.openaiResponses', frames: [eventFrame(completedEvent(usage))],
  });
  assert('frames' in result && result.frames !== undefined);
  const { frames } = result;
  assertEquals(frames.length, 1);
  const [frame] = frames;
  assert(frame.type === 'event' && 'response' in frame.event);
  return frame.event.response;
};

test('folds cache writes back as well', async () => {
  const { total_tokens: _withheld, ...usage } = {
    ...exclusiveUsage(),
    input_tokens: 100,
    output_tokens: 10,
    input_tokens_details: { cached_tokens: 120, cache_write_tokens: 80 },
  };
  const response = await run(usage as NonNullable<OpenAIResponsesResultEx['usage']>);
  assertEquals(response.usage?.input_tokens, 300);
});

test('folds the cache buckets when total_tokens witnesses exclusive counts', async () => {
  const response = await run(exclusiveUsage());
  assertEquals(response.usage?.input_tokens, 13791);
});
