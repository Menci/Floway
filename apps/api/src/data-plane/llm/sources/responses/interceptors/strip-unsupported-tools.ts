import type { ResponsesInterceptor } from '../../../interceptors.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

// Hosted Responses tool entries the gateway has no execution shim for. Codex
// emits these alongside ordinary function and Freeform `custom` tools — we
// strip them so translators do not see entries that lack a translator-friendly
// `name`/`parameters` pair.
//
// `custom` tools are NOT stripped here. Native Responses targets accept them
// directly, and translated targets wrap them into single-string function tools
// inside the pair translator.
//
// Once the source-owned web-search shim grows a Responses entry-point we can
// drop `web_search` from this set and let the shim execute it.
//
// References:
// - https://platform.openai.com/docs/guides/tools-image-generation
// - https://github.com/openai/codex/blob/ed80e5f5583d85e6f61d6839842c50b5c0630d1d/codex-rs/core/src/tools/handlers/apply_patch_spec.rs#L9-L27
// - https://github.com/caozhiyuan/copilot-api/blob/1d21b4aca31f89ad49a0c3bf1a71e3561d445855/src/routes/responses/handler.ts#L167-L184
const HOSTED_RESPONSES_TOOL_TYPES = new Set(['image_generation', 'web_search', 'tool_search', 'namespace']);

const isHostedToolType = (type: unknown): type is string => typeof type === 'string' && HOSTED_RESPONSES_TOOL_TYPES.has(type);

const stripToolChoice = (payload: ResponsesPayload, removedTool: boolean): void => {
  const choice = payload.tool_choice;

  if (choice && typeof choice === 'object' && isHostedToolType(choice.type)) {
    delete payload.tool_choice;
    return;
  }

  if (removedTool && choice === 'required' && (!Array.isArray(payload.tools) || payload.tools.length === 0)) {
    delete payload.tool_choice;
  }
};

/**
 * Strip hosted Responses tool entries the gateway cannot yet execute. Forced
 * tool choices that target a removed entry are dropped along with it; if every
 * tool was removed and the caller forced `required`, drop the choice too —
 * leaving it would force the upstream to invoke a tool that no longer exists.
 */
export const stripUnsupportedToolsFromPayload = (payload: ResponsesPayload): void => {
  let removedTool = false;

  if (Array.isArray(payload.tools)) {
    const tools = payload.tools.filter(tool => {
      const hosted = isHostedToolType(tool.type);
      removedTool ||= hosted;
      return !hosted;
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
