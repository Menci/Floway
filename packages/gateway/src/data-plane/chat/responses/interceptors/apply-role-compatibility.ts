import type { ResponsesInterceptor } from './types.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import { providerModelOf } from '@floway-dev/provider';

export const withRoleCompatibilityApplied: ResponsesInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'responses') return run();

  const flags = providerModelOf(ctx.candidate).enabledFlags;
  const rewriteSystemToDeveloper = flags.has('rewrite-system-to-developer');
  const rewriteDeveloperToSystem = flags.has('rewrite-developer-to-system');
  const rewriteMidConvSystemToUser = flags.has('rewrite-mid-conv-system-to-user');
  if (!rewriteSystemToDeveloper && !rewriteDeveloperToSystem && !rewriteMidConvSystemToUser) return run();

  let crossedLeadingSystemRun = false;
  ctx.payload = {
    ...ctx.payload,
    input: ctx.payload.input.map(item => {
      let mapped: ResponsesInputItem = item;
      if (mapped.type === 'message' && rewriteSystemToDeveloper && mapped.role === 'system') {
        mapped = { ...mapped, role: 'developer' };
      }
      if (mapped.type === 'message' && rewriteDeveloperToSystem && mapped.role === 'developer') {
        mapped = { ...mapped, role: 'system' };
      }
      const isSystemMessage = mapped.type === 'message' && mapped.role === 'system';
      if (!crossedLeadingSystemRun && !isSystemMessage) crossedLeadingSystemRun = true;
      if (rewriteMidConvSystemToUser && crossedLeadingSystemRun && mapped.type === 'message' && mapped.role === 'system') {
        mapped = { ...mapped, role: 'user' };
      }
      return mapped;
    }),
  };

  return run();
};
