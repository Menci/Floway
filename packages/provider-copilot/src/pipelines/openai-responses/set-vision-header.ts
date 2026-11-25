import type { OpenAIResponsesOperation } from './operations.ts';
import { rewriteHeaders } from '../shared/rewrite-request.ts';
import { setHeader } from '@floway-dev/http';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

/**
 * Copilot's OpenAI Responses endpoint requires the private
 * `copilot-vision-request: true` header to accept image inputs. Canonical
 * OpenAI Responses carries `input_image` blocks in message content and in multimodal
 * function/custom tool output arrays, so all three containers participate in
 * the same detection rule.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/cd0d0182eb4b9bf68a3376dc79728afa7f42ce07/src/lib/api-config.ts#L248-L258
 * - https://github.com/caozhiyuan/copilot-api/blob/cd8207cb70ede07771bf37a04accfbf2af76d980/src/routes/responses/utils.ts#L176-L201
 */
const itemHasImage = (item: CanonicalOpenAIResponsesInputItem): boolean => {
  const content = item.type === 'message'
    ? item.content
    : item.type === 'function_call_output' || item.type === 'custom_tool_call_output' ? item.output : undefined;
  return Array.isArray(content) && content.some(part => part.type === 'input_image');
};

export const setVisionHeader = (operation: OpenAIResponsesOperation) => rewriteHeaders[operation]('setVisionHeader', (payload, headers) =>
  payload.input.some(itemHasImage) ? setHeader(headers, 'copilot-vision-request', 'true') : headers);
