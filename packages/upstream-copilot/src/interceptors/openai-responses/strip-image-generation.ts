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

export const stripImageGenerationFromPayload = (payload: CanonicalOpenAIResponsesPayload): void => {
  let removedTool = false;

  if (Array.isArray(payload.tools)) {
    const tools = payload.tools.filter(tool => {
      const drop = isImageGenerationTool(tool);
      removedTool ||= drop;
      return !drop;
    });

    if (tools.length === 0) {
      delete payload.tools;
    } else {
      payload.tools = tools;
    }
  }

  payload.input = payload.input.map(item => {
    if (item.type !== 'additional_tools' && item.type !== 'tool_search_output') return item;
    const tools = item.tools.filter(tool => {
      const drop = isImageGenerationTool(tool);
      removedTool ||= drop;
      return !drop;
    });
    return tools.length === item.tools.length ? item : { ...item, tools };
  });

  if (isImageGenerationToolChoice(payload.tool_choice)) {
    if (collectOpenAIResponsesTools(payload).length === 0) delete payload.tool_choice;
    else payload.tool_choice = 'none';
    return;
  }

  if (typeof payload.tool_choice === 'object' && payload.tool_choice !== null && payload.tool_choice.type === 'allowed_tools') {
    const allowed = payload.tool_choice.tools.filter(tool => tool.type !== 'image_generation');
    if (allowed.length === payload.tool_choice.tools.length) return;
    if (allowed.length === 0 && payload.tool_choice.mode === 'auto') payload.tool_choice = 'none';
    else payload.tool_choice = { ...payload.tool_choice, tools: allowed };
    return;
  }

  // A forced `required` choice with no surviving tools would tell Copilot to
  // invoke a tool that no longer exists; drop the choice along with the tools.
  if (removedTool && payload.tool_choice === 'required' && collectOpenAIResponsesTools(payload).length === 0) {
    delete payload.tool_choice;
  }
};

export const withImageGenerationStripped = async <TResult>(
  ctx: OpenAIResponsesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  stripImageGenerationFromPayload(ctx.payload);
  return await run();
};
