import { anthropicMessages } from './anthropic-messages/index.ts';
import { anthropicMessagesCountTokens } from './anthropic-messages-count-tokens/index.ts';
import { decision } from './decision/index.ts';
import { openaiChatCompletions } from './openai-chat-completions/index.ts';
import { openaiEmbeddings } from './openai-embeddings/index.ts';
import { openaiImagesEdits } from './openai-images-edits/index.ts';
import { openaiImagesGenerations } from './openai-images-generations/index.ts';
import { openaiResponses } from './openai-responses/index.ts';
import { openaiResponsesCompact } from './openai-responses-compact/index.ts';

export const copilotPipelines = Object.freeze({
  openaiChatCompletions,
  openaiResponses,
  openaiResponsesCompact,
  anthropicMessages,
  anthropicMessagesCountTokens,
  openaiEmbeddings,
  openaiImagesGenerations,
  openaiImagesEdits,
  decision,
});
