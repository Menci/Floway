import { TranslatorInputError } from '../../translator-input-error.ts';
import type { ChatCompletionsContentPart } from '@floway-dev/protocols/chat-completions';
import type { ResponsesInputContent } from '@floway-dev/protocols/responses';

// Chat and Responses text arrays are transport fragments of one message, not
// paragraph blocks. Preserve the existing no-separator flattening.
const contentPartText = (part: ChatCompletionsContentPart | ResponsesInputContent): string | null => (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text' ? part.text : null);

const contentPartsToText = (parts: readonly (ChatCompletionsContentPart | ResponsesInputContent)[]): string =>
  parts
    .map(contentPartText)
    .filter((text): text is string => text !== null)
    .join('');

export const chatCompletionsContentToText = (content: string | ChatCompletionsContentPart[] | null): string => (typeof content === 'string' ? content : Array.isArray(content) ? contentPartsToText(content) : '');

export const chatCompletionsContentToResponsesInputContent = (content: string | ChatCompletionsContentPart[] | null): string | ResponsesInputContent[] => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length === 0) return '';

  return content.map(
    (part): ResponsesInputContent =>
      part.type === 'text'
        ? { type: 'input_text', text: part.text }
        : {
            type: 'input_image',
            image_url: part.image_url.url,
            detail: part.image_url.detail ?? 'auto',
          },
  );
};

export const responsesContentToText = (content: string | ResponsesInputContent[]): string => (typeof content === 'string' ? content : contentPartsToText(content));

export const responsesContentToChatCompletionsContent = (content: string | ResponsesInputContent[]): string | ChatCompletionsContentPart[] => {
  if (typeof content === 'string') return content;
  if (!content.every((part): part is Exclude<ResponsesInputContent, { type: 'input_file' }> => part.type !== 'input_file')) {
    throw new TranslatorInputError('Cannot translate input_file content to Chat Completions.');
  }

  return content.some(part => part.type === 'input_image')
    ? content.map(
        (part): ChatCompletionsContentPart => {
          if (part.type === 'input_image') {
            if (typeof part.image_url !== 'string') {
              throw new TranslatorInputError('Cannot translate file_id-only image content to Chat Completions.');
            }
            let detail: 'auto' | 'low' | 'high';
            switch (part.detail) {
            case 'auto': detail = 'auto'; break;
            case 'low': detail = 'low'; break;
            case 'high': detail = 'high'; break;
            default:
              throw new TranslatorInputError(`Cannot translate image detail '${part.detail}' to Chat Completions.`);
            }
            return {
              type: 'image_url',
              image_url: {
                url: part.image_url,
                detail,
              },
            };
          }
          return { type: 'text', text: part.text };
        },
      )
    : contentPartsToText(content);
};
