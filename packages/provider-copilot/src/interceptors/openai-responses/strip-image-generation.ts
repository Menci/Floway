import type { OpenAIResponsesBoundaryCtx } from './types.ts';
import { collectOpenAIResponsesTools, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesTool, type OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';

/**
 * A Copilot gateway filters public `image_generation` from Responses requests,
 * while OpenAI supports it. Apply this provider-specific rule after target
 * selection to every declaration carrier and selector, retaining unrelated
 * tools in their declaration containers and relative order.
 *
 * https://developers.openai.com/api/docs/guides/tools-image-generation
 * https://github.com/caozhiyuan/copilot-api/blob/5d37d5b1ac6566c935a5c26d046396ee5fa423cc/src/routes/responses/handler.ts#L187-L204
 */
const isImageGenerationTool = (tool: OpenAIResponsesTool): boolean => tool.type === 'image_generation';

const isImageGenerationToolChoice = (choice: OpenAIResponsesToolChoice | null | undefined): boolean =>
  typeof choice === 'object' && choice !== null && choice.type === 'image_generation';

const withoutToolChoice = (payload: CanonicalOpenAIResponsesPayload): CanonicalOpenAIResponsesPayload => {
  const { tool_choice: _choice, ...rest } = payload;
  return rest;
};

export const stripImageGenerationFromPayload = (payload: CanonicalOpenAIResponsesPayload): CanonicalOpenAIResponsesPayload => {
  let removedTool = false;
  const filter = (tools: OpenAIResponsesTool[]): OpenAIResponsesTool[] => {
    const filtered = tools.filter(tool => {
      const drop = isImageGenerationTool(tool);
      removedTool ||= drop;
      return !drop;
    });
    return filtered.length === tools.length ? tools : filtered;
  };
  let rewritten = payload;
  if (Array.isArray(payload.tools)) {
    const tools = filter(payload.tools);
    if (tools.length === 0) {
      const { tools: _tools, ...rest } = rewritten;
      rewritten = rest;
    } else if (tools !== payload.tools) rewritten = { ...rewritten, tools };
  }
  const input = payload.input.map(item => {
    if (item.type !== 'additional_tools' && item.type !== 'tool_search_output') return item;
    const tools = filter(item.tools);
    return tools === item.tools ? item : { ...item, tools };
  });
  if (input.some((item, index) => item !== payload.input[index])) rewritten = { ...rewritten, input };
  const choice = rewritten.tool_choice;
  if (isImageGenerationToolChoice(choice)) {
    return collectOpenAIResponsesTools(rewritten).length === 0
      ? withoutToolChoice(rewritten) : { ...rewritten, tool_choice: 'none' };
  }
  if (typeof choice === 'object' && choice !== null && choice.type === 'allowed_tools') {
    const allowed = choice.tools.filter(tool => tool.type !== 'image_generation');
    if (allowed.length === choice.tools.length) return rewritten;
    return { ...rewritten, tool_choice: allowed.length === 0 && choice.mode === 'auto' ? 'none' : { ...choice, tools: allowed } };
  }
  // Filtering a required choice must not expose tools outside its declared subset.
  if (removedTool && choice === 'required' && collectOpenAIResponsesTools(rewritten).length === 0) return withoutToolChoice(rewritten);
  return rewritten;
};

export const withImageGenerationStripped = async <TResult>(
  ctx: OpenAIResponsesBoundaryCtx,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  ctx.payload = stripImageGenerationFromPayload(ctx.payload);
  return await run();
};
