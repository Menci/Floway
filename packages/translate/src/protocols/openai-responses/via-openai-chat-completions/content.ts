import { TranslateInputException } from '../../../shared/input-error.ts';
import type { OpenAIChatCompletionsUserContentPart } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesInputContent, OpenAIResponsesAssistantInputContent } from '@floway-dev/protocols/openai-responses';

// OpenAI Chat Completions and OpenAI Responses text arrays are transport fragments of one message, not
// paragraph blocks. Preserve the existing no-separator flattening.
const contentPartText = (part: OpenAIChatCompletionsUserContentPart | OpenAIResponsesAssistantInputContent): string | null => (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text' ? part.text : null);

const contentPartsToText = (parts: readonly (OpenAIChatCompletionsUserContentPart | OpenAIResponsesAssistantInputContent)[]): string =>
  parts
    .map(contentPartText)
    .filter((text): text is string => text !== null)
    .join('');

export const openaiResponsesContentToText = (content: string | OpenAIResponsesAssistantInputContent[]): string => (typeof content === 'string' ? content : contentPartsToText(content));

export const openaiResponsesContentToOpenAIChatCompletionsContent = (content: string | OpenAIResponsesInputContent[]): string | OpenAIChatCompletionsUserContentPart[] => {
  if (typeof content === 'string') return content;
  if (!content.every((part): part is Exclude<OpenAIResponsesInputContent, { type: 'input_file' }> => part.type !== 'input_file')) {
    throw new TranslateInputException('Cannot translate input_file content to OpenAI Chat Completions.');
  }

  return content.some(part => part.type === 'input_image')
    ? content.map(
        (part): OpenAIChatCompletionsUserContentPart => {
          if (part.type === 'input_image') {
            if (typeof part.image_url !== 'string') {
              throw new TranslateInputException('Cannot translate file_id-only image content to OpenAI Chat Completions.');
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
          return { type: 'text', text: part.text };
        },
      )
    : contentPartsToText(content);
};
