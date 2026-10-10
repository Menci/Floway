import { TranslatorInputError } from '../../translator-input-error.ts';
import type { AnthropicMessagesClientTool } from '@floway-dev/protocols/anthropic-messages';

export const anthropicMessagesToolInputSchema = (schema: Record<string, unknown>): AnthropicMessagesClientTool['input_schema'] => {
  if (schema.type !== 'object') throw new TranslatorInputError('Anthropic Messages function tools require an object input schema.');
  return schema as AnthropicMessagesClientTool['input_schema'];
};
