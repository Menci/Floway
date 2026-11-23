import type { RouteCandidate } from '../../../pipeline/services.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesInputItem, CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

interface Request {
  readonly 'request.payload': CanonicalOpenAIResponsesPayload;
  readonly 'route.candidate': RouteCandidate;
}

export const applyRoleCompatibility = defineStage<Request, Request, object, object>({
  name: 'applyRoleCompatibility',
  through: {
    request: { needs: ['request.payload', 'route.candidate'], consumes: [], provides: ['request.payload'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    const payload = facts['request.payload'];
    const flags = facts['route.candidate'].providerModel.enabledFlags;
    const rewriteSystemToDeveloper = flags.includes('rewrite-system-to-developer');
    const rewriteDeveloperToSystem = flags.includes('rewrite-developer-to-system');
    const rewriteMidConvSystemToUser = flags.includes('rewrite-mid-conv-system-to-user');
    if (!rewriteSystemToDeveloper && !rewriteDeveloperToSystem && !rewriteMidConvSystemToUser) return await next(facts);

    let crossedLeadingSystemRun = false;
    const input = payload.input.map(item => {
      let mapped: CanonicalOpenAIResponsesInputItem = item;
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
    });
    return await next({ ...facts, 'request.payload': { ...payload, input } });
  },
});
