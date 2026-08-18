// Every family assembles. Assembly is a check over declarations, and a family whose
// pipeline is built from the request assembles only when something builds one — so a
// pipeline that could never run can sit in the tree looking fine. This test builds all of
// them, which is what turns "the declarations disagree" into a failure at `pnpm test`
// rather than on the first request that reaches the route.

import { describe, expect, it } from 'vitest';

import { searchServePipeline } from '../../../src/data-plane/alpha-search/pipeline.ts';
import { anthropicMessagesCountTokensPipeline } from '../../../src/data-plane/chat/anthropic-messages/count-tokens.ts';
import { anthropicMessagesServePipeline } from '../../../src/data-plane/chat/anthropic-messages/pipeline.ts';
import { geminiGenerateContentCountTokensPipeline } from '../../../src/data-plane/chat/gemini-generate-content/count-tokens.ts';
import { geminiGenerateContentServePipeline } from '../../../src/data-plane/chat/gemini-generate-content/pipeline.ts';
import { openaiChatCompletionsServePipeline } from '../../../src/data-plane/chat/openai-chat-completions/pipeline.ts';
import { openaiResponsesCompactPipeline } from '../../../src/data-plane/chat/openai-responses/compact.ts';
import { openaiResponsesServePipeline } from '../../../src/data-plane/chat/openai-responses/pipeline.ts';
import { openaiAudioTranscriptionServePipeline } from '../../../src/data-plane/openai-audio/pipeline.ts';
import { openaiCompletionsServePipeline } from '../../../src/data-plane/openai-completions/pipeline.ts';
import { openaiEmbeddingsServePipeline } from '../../../src/data-plane/openai-embeddings/pipeline.ts';
import { openaiImagesServePipeline } from '../../../src/data-plane/openai-images/pipeline.ts';
import { rerankServePipeline } from '../../../src/data-plane/rerank/pipeline.ts';

const FAMILIES: readonly (readonly [string, () => { readonly name: string }])[] = [
  ['OpenAI Embeddings', () => openaiEmbeddingsServePipeline],
  ['rerank', () => rerankServePipeline({ sourceProtocol: 'cohere-v2', raw: {}, query: 'q', documents: ['a'] } as never)],
  ['OpenAI Images generations', () => openaiImagesServePipeline({ operation: 'generations', parameters: {} } as never)],
  ['OpenAI Images edits', () => openaiImagesServePipeline({ operation: 'edits', images: [], parameters: {} } as never)],
  ['OpenAI Completions', () => openaiCompletionsServePipeline],
  ['OpenAI Audio Transcriptions', () => openaiAudioTranscriptionServePipeline],
  ['alpha search', () => searchServePipeline({ kind: 'search' } as never)],
  ['OpenAI Chat Completions', () => openaiChatCompletionsServePipeline({ model: 'm', messages: [] } as never)],
  ['Anthropic Messages', () => anthropicMessagesServePipeline({ model: 'm', messages: [] } as never)],
  ['Gemini generateContent', () => geminiGenerateContentServePipeline({ model: 'm', contents: [] } as never)],
  ['OpenAI Responses', () => openaiResponsesServePipeline({ model: 'm', input: [] } as never)],
  ['Anthropic Messages count_tokens', () => anthropicMessagesCountTokensPipeline({ model: 'm', messages: [] } as never)],
  ['Gemini countTokens', () => geminiGenerateContentCountTokensPipeline({ model: 'm', contents: [] } as never)],
  ['OpenAI Responses compact', () => openaiResponsesCompactPipeline({ model: 'm', input: [] } as never)],
];

describe('every family assembles', () => {
  for (const [name, build] of FAMILIES) {
    it(`${name} composes into a pipeline`, () => {
      expect(build().name).toBeTypeOf('string');
    });
  }
});
