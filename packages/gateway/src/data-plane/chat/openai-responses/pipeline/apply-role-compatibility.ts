import { openAIResponsesTargetFor } from './target.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

const { defineStage } = gatewayFactSpace<{}>();

export const applyOpenAIResponsesRoleCompatibility = defineStage({
  name: 'openaiResponses.apply-role-compatibility',
  through: {
    request: { needs: ['request.openaiResponses', 'serve.candidate'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const candidate = facts['serve.candidate'];
      if (openAIResponsesTargetFor(candidate) !== 'openaiResponses') return facts;
      const flags = candidate.model.enabledFlags;
      const rewriteSystemToDeveloper = flags.includes('rewrite-system-to-developer');
      const rewriteDeveloperToSystem = flags.includes('rewrite-developer-to-system');
      const rewriteMidConvSystemToUser = flags.includes('rewrite-mid-conv-system-to-user');
      if (!rewriteSystemToDeveloper && !rewriteDeveloperToSystem && !rewriteMidConvSystemToUser) return facts;

      const payload = facts['request.openaiResponses'];
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
        crossedLeadingSystemRun ||= !isSystemMessage;
        if (rewriteMidConvSystemToUser && crossedLeadingSystemRun && mapped.type === 'message' && mapped.role === 'system') {
          mapped = { ...mapped, role: 'user' };
        }
        return mapped;
      });
      return { ...facts, 'request.openaiResponses': move({ ...payload, input }) };
    },
  })),
});
