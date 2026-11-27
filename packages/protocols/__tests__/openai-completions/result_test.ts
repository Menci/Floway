import { expect, test } from 'vitest';

import { parseJSONWithRawNumbers } from '../../src/common/json.ts';
import { decodeOpenAICompletionsResult } from '../../src/openai-completions/index.ts';

test('OpenAI Completions normalizes typed result numbers and preserves unknown numeric tokens', () => {
  const text = '{"id":"c","object":"text_completion","model":"m","created":1e0,"choices":[{"index":0.0,"text":"hello","finish_reason":"stop","logprobs":{"vendor":1e0}}],"usage":{"prompt_tokens":2e0,"completion_tokens":1.0,"total_tokens":3.0,"prompt_tokens_details":{"cached_tokens":1e0,"vendor":2e0}}}';
  expect(decodeOpenAICompletionsResult(JSON.parse(text)).ok).toBe(true);
  const decoded = decodeOpenAICompletionsResult(parseJSONWithRawNumbers(text));
  if (!decoded.ok) throw decoded.error;
  expect(decoded.value).toMatchObject({
    created: 1,
    choices: [{ index: 0 }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, prompt_tokens_details: { cached_tokens: 1 } },
  });
  expect(JSON.stringify(decoded.value)).toContain('"logprobs":{"vendor":1e0}');
  expect(JSON.stringify(decoded.value)).toContain('"cached_tokens":1,"vendor":2e0');
});
