import type { ResponsesBoundaryCtx } from './types.ts';
import type { ResponsesTool, ResponsesToolChoice } from '@floway-dev/protocols/responses';

// Copilot rejects both the hosted image_generation tool and Codex's image_gen
// namespace before inference. The gateway shim normally consumes them; this is
// the disabled-shim fallback, scoped by exact namespace name.
// https://github.com/caozhiyuan/copilot-api/issues/206
// https://github.com/caozhiyuan/copilot-api/issues/312
// https://github.com/caozhiyuan/copilot-api/commit/e260303a1ccc48390b0b710fa40631562f1a37fb
const isImageGenerationReference = (
  value: ResponsesTool | ResponsesToolChoice | null | undefined,
): boolean =>
  typeof value === 'object'
  && value !== null
  && (value.type === 'image_generation'
    || (value.type === 'namespace' && value.name === 'image_gen'));

export const withImageGenerationStripped = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const { payload } = ctx;
  let removedTool = false;

  if (Array.isArray(payload.tools)) {
    const tools = payload.tools.filter(tool => {
      const drop = isImageGenerationReference(tool);
      removedTool ||= drop;
      return !drop;
    });

    if (tools.length === 0) {
      delete payload.tools;
    } else {
      payload.tools = tools;
    }
  }

  if (isImageGenerationReference(payload.tool_choice)) {
    delete payload.tool_choice;
  } else if (removedTool && payload.tool_choice === 'required' && (!Array.isArray(payload.tools) || payload.tools.length === 0)) {
    // `required` cannot be satisfied after the last declared tool is removed.
    delete payload.tool_choice;
  }

  return await run();
};
