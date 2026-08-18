// Every family assembles. Assembly is a check over declarations, and a family whose
// pipeline is built from the request assembles only when something builds one — so a
// pipeline that could never run can sit in the tree looking fine. This test builds all of
// them, which is what turns "the declarations disagree" into a failure at `pnpm test`
// rather than on the first request that reaches the route.

import { describe, expect, it } from 'vitest';

import { searchServePipeline } from '../../../src/data-plane/alpha-search/pipeline.ts';
import { audioTranscriptionServePipeline } from '../../../src/data-plane/audio/pipeline.ts';
import { openaiChatCompletionsServePipeline } from '../../../src/data-plane/chat/openai-chat-completions/pipeline.ts';
import { geminiGenerateContentCountTokensPipeline } from '../../../src/data-plane/chat/gemini-generate-content/count-tokens.ts';
import { geminiGenerateContentServePipeline } from '../../../src/data-plane/chat/gemini-generate-content/pipeline.ts';
import { anthropicMessagesCountTokensPipeline } from '../../../src/data-plane/chat/anthropic-messages/count-tokens.ts';
import { anthropicMessagesServePipeline } from '../../../src/data-plane/chat/anthropic-messages/pipeline.ts';
import { openaiResponsesCompactPipeline } from '../../../src/data-plane/chat/openai-responses/compact.ts';
import { openaiResponsesServePipeline } from '../../../src/data-plane/chat/openai-responses/pipeline.ts';
import { completionsServePipeline } from '../../../src/data-plane/completions/pipeline.ts';
import { embeddingsServePipeline } from '../../../src/data-plane/embeddings/pipeline.ts';
import { imagesServePipeline } from '../../../src/data-plane/images/pipeline.ts';
import { rerankServePipeline } from '../../../src/data-plane/rerank/pipeline.ts';

const FAMILIES: readonly (readonly [string, () => { readonly name: string }])[] = [
  ['embeddings', () => embeddingsServePipeline],
  ['rerank', () => rerankServePipeline({ sourceProtocol: 'cohere-v2', raw: {}, query: 'q', documents: ['a'] } as never)],
  ['images generations', () => imagesServePipeline({ operation: 'generations', parameters: {} } as never)],
  ['images edits', () => imagesServePipeline({ operation: 'edits', images: [], parameters: {} } as never)],
  ['completions', () => completionsServePipeline],
  ['audio transcription', () => audioTranscriptionServePipeline],
  ['alpha search', () => searchServePipeline({ kind: 'search' } as never)],
  ['chat completions', () => openaiChatCompletionsServePipeline({ model: 'm', messages: [] } as never)],
  ['messages', () => anthropicMessagesServePipeline({ model: 'm', messages: [] } as never)],
  ['gemini', () => geminiGenerateContentServePipeline({ model: 'm', contents: [] } as never)],
  ['responses', () => openaiResponsesServePipeline({ model: 'm', input: [] } as never)],
  ['messages count_tokens', () => anthropicMessagesCountTokensPipeline({ model: 'm', messages: [] } as never)],
  ['gemini countTokens', () => geminiGenerateContentCountTokensPipeline({ model: 'm', contents: [] } as never)],
  ['responses compact', () => openaiResponsesCompactPipeline({ model: 'm', input: [] } as never)],
];

describe('every family assembles', () => {
  for (const [name, build] of FAMILIES) {
    it(`${name} composes into a pipeline`, () => {
      expect(build().name).toBeTypeOf('string');
    });
  }
});
