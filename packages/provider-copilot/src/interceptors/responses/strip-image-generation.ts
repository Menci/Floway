import type { ResponsesBoundaryCtx } from './types.ts';
import type { ResponsesPayload, ResponsesTool, ResponsesToolChoice } from '@floway-dev/protocols/responses';

/**
 * Copilot's `/responses` endpoint rejects public `image_generation` tool
 * entries, so strip them once the planner has committed to a native Responses
 * target on a Copilot upstream. Other Responses-capable upstreams (e.g. OpenAI
 * direct) accept the entry and must continue to see it. Other public hosted
 * and deferred tools (`web_search`, `tool_search`, `namespace`) are left in
 * place: Codex relies on `tool_search` / `namespace` for client-executed
 * deferred tool discovery, and Copilot accepts `web_search`.
 *
 * References:
 * - https://platform.openai.com/docs/guides/tools-image-generation
 * - https://github.com/openai/codex/blob/9f42c89c0112771dc29100a6f3fc904049b2655f/codex-rs/tools/src/tool_spec.rs#L17-L27
 * - https://github.com/caozhiyuan/copilot-api/blob/5d37d5b1ac6566c935a5c26d046396ee5fa423cc/src/routes/responses/handler.ts#L187-L204
 */
const isImageGenerationTool = (tool: ResponsesTool): boolean => tool.type === 'image_generation';

const isImageGenerationToolChoice = (choice: ResponsesToolChoice | undefined): boolean =>
  typeof choice === 'object' && choice !== null && (choice as { type?: unknown }).type === 'image_generation';

export const stripImageGenerationFromPayload = (payload: ResponsesPayload): void => {
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

  if (isImageGenerationToolChoice(payload.tool_choice)) {
    delete payload.tool_choice;
    return;
  }

  // A forced `required` choice with no surviving tools would tell Copilot to
  // invoke a tool that no longer exists; drop the choice along with the tools.
  if (removedTool && payload.tool_choice === 'required' && (!Array.isArray(payload.tools) || payload.tools.length === 0)) {
    delete payload.tool_choice;
  }
};

export const withImageGenerationStripped = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  stripImageGenerationFromPayload(ctx.payload);
  return await run();
};
