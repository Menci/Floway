import { defineCopilotStage, type CopilotFacts } from '../facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import { collectOpenAIResponsesTools, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
type Payload = CopilotFacts['request.openaiResponses'] & Pick<CanonicalOpenAIResponsesPayload, 'tools' | 'tool_choice'>;

export const stripImageGenerationFromPayload = (payload: Payload): Payload => {
  let removed = false;
  const keepTool = (tool: OpenAIResponsesTool): boolean => {
    const keep = tool.type !== 'image_generation';
    removed ||= !keep;
    return keep;
  };

  const { tools: rootTools, tool_choice: choice, ...rest } = payload;
  const tools = Array.isArray(rootTools) ? rootTools.filter(keepTool) : rootTools;
  const input = payload.input.map(item => {
    if (item.type !== 'additional_tools' && item.type !== 'tool_search_output') return item;
    const tools = item.tools.filter(keepTool);
    return tools.length === item.tools.length ? item : { ...item, tools };
  });
  const clean = {
    ...rest,
    input,
    ...(tools === undefined || (Array.isArray(tools) && tools.length === 0) ? {} : { tools }),
  };
  const hasTools = (): boolean => collectOpenAIResponsesTools({
    model: clean.model,
    input,
    ...(tools !== undefined && { tools }),
  }).length > 0;

  if (typeof choice === 'object' && choice !== null) {
    if (choice.type === 'image_generation') {
      return hasTools() ? { ...clean, tool_choice: 'none' } : clean;
    }
    if (choice.type === 'allowed_tools') {
      const allowed = choice.tools.filter(tool => tool.type !== 'image_generation');
      if (allowed.length !== choice.tools.length) {
        return { ...clean, tool_choice: allowed.length === 0 && choice.mode === 'auto' ? 'none' : { ...choice, tools: allowed } };
      }
    }
  }

  if (choice === 'required' && removed && !hasTools()) return clean;
  return choice === undefined ? clean : { ...clean, tool_choice: choice };
};
// https://github.com/caozhiyuan/copilot-api/blob/5d37d5b1ac6566c935a5c26d046396ee5fa423cc/src/routes/responses/handler.ts#L187-L204
export const stripImageGeneration = defineCopilotStage({
  name: 'copilot.openaiResponses.stripImageGeneration',
  through: {
    request: { needs: ['request.openaiResponses'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.openaiResponses'];
      const next = stripImageGenerationFromPayload(payload);
      return { ...facts, 'request.openaiResponses': move(next) };
    },
  })),
});
