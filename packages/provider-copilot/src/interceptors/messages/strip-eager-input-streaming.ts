import type { CopilotMessagesBoundaryInterceptor } from './types.ts';

/**
 * `eager_input_streaming` is a per-tool property in the Anthropic Messages API
 * that enables fine-grained tool input streaming. Copilot's native Messages
 * target has been observed to reject it with
 * `"tools.N.custom.eager_input_streaming: Extra inputs are not permitted"`, so
 * strip it only at the Copilot target boundary and leave other providers
 * untouched.
 *
 * References:
 * - https://github.com/anthropics/anthropic-sdk-typescript/blob/a53f60d59ca904f3e79296586642aac3ce68ae02/src/resources/messages/messages.ts#L1761
 */
export const withEagerInputStreamingStripped: CopilotMessagesBoundaryInterceptor = async (ctx, _env, run) => {
  if (ctx.payload.tools) {
    ctx.payload.tools = ctx.payload.tools.map(tool => {
      const { eager_input_streaming: _, ...rest } = tool as typeof tool & {
        eager_input_streaming?: unknown;
      };
      return rest;
    });
  }

  return await run();
};
