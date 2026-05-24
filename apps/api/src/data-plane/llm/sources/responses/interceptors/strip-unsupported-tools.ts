import type { ResponsesInterceptor } from '../../../interceptors.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

// Copilot's Responses endpoint rejects public `image_generation` tool entries.
// Remove only that upstream-incompatible entry here. Codex uses `tool_search`
// and `namespace` for client-executed deferred tool discovery, so native
// Responses targets must still see those entries.
//
// References:
// - https://platform.openai.com/docs/guides/tools-image-generation
// - https://github.com/openai/codex/blob/9f42c89c0112771dc29100a6f3fc904049b2655f/codex-rs/tools/src/tool_spec.rs#L17-L27
// - https://github.com/caozhiyuan/copilot-api/blob/5d37d5b1ac6566c935a5c26d046396ee5fa423cc/src/routes/responses/handler.ts#L187-L204
const UNSUPPORTED_RESPONSES_TOOL_TYPES = new Set(['image_generation']);

const isUnsupportedToolType = (type: unknown): type is string => typeof type === 'string' && UNSUPPORTED_RESPONSES_TOOL_TYPES.has(type);

const stripToolChoice = (payload: ResponsesPayload, removedTool: boolean): void => {
  const choice = payload.tool_choice;

  if (choice && typeof choice === 'object' && isUnsupportedToolType(choice.type)) {
    delete payload.tool_choice;
    return;
  }

  if (removedTool && choice === 'required' && (!Array.isArray(payload.tools) || payload.tools.length === 0)) {
    delete payload.tool_choice;
  }
};

/**
 * Strip Responses tool entries that the selected upstream rejects before target
 * request construction. Forced tool choices that target a removed entry are
 * dropped along with it; if every tool was removed and the caller forced
 * `required`, drop the choice too — leaving it would force the upstream to
 * invoke a tool that no longer exists.
 */
export const stripUnsupportedToolsFromPayload = (payload: ResponsesPayload): void => {
  let removedTool = false;

  if (Array.isArray(payload.tools)) {
    const tools = payload.tools.filter(tool => {
      const unsupported = isUnsupportedToolType(tool.type);
      removedTool ||= unsupported;
      return !unsupported;
    });

    if (tools.length === 0) {
      delete payload.tools;
    } else {
      payload.tools = tools;
    }
  }

  stripToolChoice(payload, removedTool);
};

export const stripUnsupportedTools: ResponsesInterceptor = (ctx, _request, run) => {
  stripUnsupportedToolsFromPayload(ctx.payload);
  return run();
};
