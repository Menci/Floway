import { expect, test } from 'vitest';

import { formatAlphaSearchError } from '../../src/alpha-search/index.ts';
import { formatDecisionError } from '../../src/decision/index.ts';
import { formatOpenAIAudioTranscriptionsError } from '../../src/openai-audio/index.ts';
import { formatOpenAIChatCompletionsError } from '../../src/openai-chat-completions/index.ts';
import { formatOpenAICompletionsError } from '../../src/openai-completions/index.ts';
import { formatOpenAIEmbeddingsError } from '../../src/openai-embeddings/index.ts';
import { formatOpenAIImagesEditsError, formatOpenAIImagesGenerationsError } from '../../src/openai-images/index.ts';
import { formatRerankError } from '../../src/rerank/index.ts';

test.each([
  formatAlphaSearchError,
  formatDecisionError,
  formatOpenAIAudioTranscriptionsError,
  formatOpenAIChatCompletionsError,
  formatOpenAICompletionsError,
  formatOpenAIEmbeddingsError,
  formatOpenAIImagesEditsError,
  formatOpenAIImagesGenerationsError,
  formatRerankError,
])('uses the OpenAI API error envelope for an unstructured upstream failure %#', format => {
  expect(format(null, 'upstream failure')).toEqual({ error: { type: 'api_error', message: 'upstream failure' } });
});
