import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { OpenAIChatCompletionsContentPart } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesInputContent } from '@floway-dev/protocols/openai-responses';

// OpenAI Chat Completions and OpenAI Responses text arrays are transport fragments of one message, not
// paragraph blocks. Preserve the existing no-separator flattening.
const contentPartText = (part: OpenAIChatCompletionsContentPart | OpenAIResponsesInputContent): string | null => (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text' ? part.text : null);

const contentPartsToText = (parts: readonly (OpenAIChatCompletionsContentPart | OpenAIResponsesInputContent)[]): string =>
  parts
    .map(contentPartText)
    .filter((text): text is string => text !== null)
    .join('');

export const openaiChatCompletionsContentToText = (content: string | OpenAIChatCompletionsContentPart[] | null | undefined): string => (typeof content === 'string' ? content : Array.isArray(content) ? contentPartsToText(content) : '');

export const openaiChatCompletionsContentToOpenAIResponsesInputContent = (content: string | OpenAIChatCompletionsContentPart[] | null | undefined): string | OpenAIResponsesInputContent[] => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length === 0) return '';

  return content.map(
    (part): OpenAIResponsesInputContent => {
      switch (part.type) {
      case 'text':
        return { type: 'input_text', text: part.text };
      case 'refusal':
        return { type: 'refusal', refusal: part.refusal };
      case 'input_audio':
        throw new TranslatorInputError('Cannot translate input_audio content to OpenAI Responses.');
      case 'file':
        return { type: 'input_file', ...part.file };
      case 'image_url':
        return {
          type: 'input_image',
          image_url: part.image_url.url,
          ...(part.image_url.detail === undefined ? {} : { detail: part.image_url.detail }),
        };
      }
    },
  );
};
