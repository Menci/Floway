import type { ResponsesInterceptor } from './types.ts';
import { redirectCodexUltraEffort } from '../../../codex/ultra-redirect.ts';

// Source-protocol compatibility entry. The marker on ChatGatewayCtx is set
// only by `/azure-api.codex/responses`; ordinary OpenAI-compatible Responses
// requests retain every open-string effort value verbatim.
export const withCodexUltraEffortRedirected: ResponsesInterceptor = async (ctx, gatewayCtx, run) => {
  const redirectEffort = gatewayCtx.codexUltraRedirectEffort;
  if (redirectEffort === null) return await run();
  ctx.payload = redirectCodexUltraEffort(ctx.payload, redirectEffort);
  return await run();
};
