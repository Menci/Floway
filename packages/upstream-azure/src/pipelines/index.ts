import { azureAnthropicMessagesPipeline } from './anthropic-messages/index.ts';
import { azureAnthropicMessagesCountTokensPipeline } from './anthropic-messages-count-tokens/index.ts';
import { azureDecisionPipeline } from './decision/index.ts';
import { azureOpenAIAudioTranscriptionsPipeline } from './openai-audio-transcriptions/index.ts';
import { azureOpenAIChatCompletionsPipeline } from './openai-chat-completions/index.ts';
import { azureOpenAICompletionsPipeline } from './openai-completions/index.ts';
import { azureOpenAIEmbeddingsPipeline } from './openai-embeddings/index.ts';
import { azureOpenAIImagesEditsPipeline } from './openai-images-edits/index.ts';
import { azureOpenAIImagesGenerationsPipeline } from './openai-images-generations/index.ts';
import { azureOpenAIResponsesPipeline } from './openai-responses/index.ts';
import { azureOpenAIResponsesCompactPipeline } from './openai-responses-compact/index.ts';

export const azurePipelines = Object.freeze({
  anthropicMessages: azureAnthropicMessagesPipeline,
  anthropicMessagesCountTokens: azureAnthropicMessagesCountTokensPipeline,
  decision: azureDecisionPipeline,
  openaiAudioTranscriptions: azureOpenAIAudioTranscriptionsPipeline,
  openaiChatCompletions: azureOpenAIChatCompletionsPipeline,
  openaiCompletions: azureOpenAICompletionsPipeline,
  openaiEmbeddings: azureOpenAIEmbeddingsPipeline,
  openaiImagesEdits: azureOpenAIImagesEditsPipeline,
  openaiImagesGenerations: azureOpenAIImagesGenerationsPipeline,
  openaiResponses: azureOpenAIResponsesPipeline,
  openaiResponsesCompact: azureOpenAIResponsesCompactPipeline,
});

export {
  azureAnthropicMessagesPipeline,
  azureAnthropicMessagesCountTokensPipeline,
  azureDecisionPipeline,
  azureOpenAIAudioTranscriptionsPipeline,
  azureOpenAIChatCompletionsPipeline,
  azureOpenAICompletionsPipeline,
  azureOpenAIEmbeddingsPipeline,
  azureOpenAIImagesEditsPipeline,
  azureOpenAIImagesGenerationsPipeline,
  azureOpenAIResponsesPipeline,
  azureOpenAIResponsesCompactPipeline,
};
