import { TranslatorInputError } from '../../translator-input-error.ts';
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

export const openaiChatCompletionsContentToText = (content: string | OpenAIChatCompletionsContentPart[] | null): string => (typeof content === 'string' ? content : Array.isArray(content) ? contentPartsToText(content) : '');

export const openaiChatCompletionsContentToOpenAIResponsesInputContent = (content: string | OpenAIChatCompletionsContentPart[] | null): string | OpenAIResponsesInputContent[] => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length === 0) return '';

  return content.map(
    (part): OpenAIResponsesInputContent => {
      switch (part.type) {
      case 'text':
        return { type: 'input_text', text: part.text };
      case 'refusal':
        return { type: 'refusal', refusal: part.refusal };
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

export const openaiResponsesContentToText = (content: string | OpenAIResponsesInputContent[]): string => (typeof content === 'string' ? content : contentPartsToText(content));

export const openaiResponsesContentToOpenAIChatCompletionsContent = (content: string | OpenAIResponsesInputContent[]): string | OpenAIChatCompletionsContentPart[] => {
  if (typeof content === 'string') return content;
  if (!content.every((part): part is Exclude<OpenAIResponsesInputContent, { type: 'input_file' }> => part.type !== 'input_file')) {
    throw new TranslatorInputError('Cannot translate input_file content to OpenAI Chat Completions.');
  }

  return content.some(part => part.type === 'input_image' || part.type === 'refusal')
    ? content.map(
        (part): OpenAIChatCompletionsContentPart => {
          if (part.type === 'input_image') {
            if (typeof part.image_url !== 'string') {
              throw new TranslatorInputError('Cannot translate file_id-only image content to OpenAI Chat Completions.');
            }
            return {
              type: 'image_url',
              image_url: {
                url: part.image_url,
                // Both protocols read an absent `detail` as `auto`, and OpenAI Chat Completions
                // Completions has no null member, so an absent or null value
                // becomes an omitted key. Anything else is the upstream's to
                // accept or reject.
                // https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L30795-L30803
                // https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L67946-L67951
                ...(part.detail == null ? {} : { detail: part.detail }),
              },
            };
          }
          if (part.type === 'refusal') return { type: 'refusal', refusal: part.refusal };
          return { type: 'text', text: part.text };
        },
      )
    : contentPartsToText(content);
};
