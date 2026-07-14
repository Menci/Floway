import type { ResponsesInterceptor } from './types.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import { providerModelOf } from '@floway-dev/provider';

export const withRoleCompatibilityApplied: ResponsesInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'responses') return run();

  const flags = providerModelOf(ctx.candidate).enabledFlags;
  const promoteSystem = flags.has('promote-system-to-developer');
  const demoteDeveloper = flags.has('demote-developer-to-system');
  const demoteInterleavedSystem = flags.has('demote-interleaved-system-to-user');
  if (!promoteSystem && !demoteDeveloper && !demoteInterleavedSystem) return run();

  let crossedLeadingSystemRun = false;
  ctx.payload = {
    ...ctx.payload,
    input: ctx.payload.input.map(item => {
      let mapped: ResponsesInputItem = item;
      if (mapped.type === 'message' && promoteSystem && mapped.role === 'system') {
        mapped = { ...mapped, role: 'developer' };
      }
      if (mapped.type === 'message' && demoteDeveloper && mapped.role === 'developer') {
        mapped = { ...mapped, role: 'system' };
      }
      const isSystemMessage = mapped.type === 'message' && mapped.role === 'system';
      if (!crossedLeadingSystemRun && !isSystemMessage) crossedLeadingSystemRun = true;
      if (demoteInterleavedSystem && crossedLeadingSystemRun && mapped.type === 'message' && mapped.role === 'system') {
        mapped = { ...mapped, role: 'user' };
      }
      return mapped;
    }),
  };

  return run();
};
