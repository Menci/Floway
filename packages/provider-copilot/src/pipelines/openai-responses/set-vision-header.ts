import { defineCopilotStage } from '../facts.ts';
import { setHeader } from '@floway-dev/http';
import { move, transform } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
const itemHasImage = (item: CanonicalOpenAIResponsesInputItem): boolean => {
  const content = item.type === 'message'
    ? item.content
    : item.type === 'function_call_output' || item.type === 'custom_tool_call_output' ? item.output : undefined;
  return Array.isArray(content) && content.some(part => part.type === 'input_image');
};
// https://github.com/caozhiyuan/copilot-api/blob/cd0d0182eb4b9bf68a3376dc79728afa7f42ce07/src/lib/api-config.ts#L248-L258
// https://github.com/caozhiyuan/copilot-api/blob/cd8207cb70ede07771bf37a04accfbf2af76d980/src/routes/responses/utils.ts#L176-L201
export const setVisionHeader = defineCopilotStage({
  name: 'copilot.openaiResponses.setVisionHeader',
  through: {
    request: { needs: ['request.openaiResponses', 'request.http'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.openaiResponses'];
      const request = facts['request.http'];
      if (!payload.input.some(itemHasImage)) return facts;
      const headers = setHeader(request.headers, 'copilot-vision-request', 'true');
      return { ...facts, 'request.http': move({ ...request, headers }) };
    },
  })),
});
