import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { providerSupportsOperation } from '../../../pipeline/provider-pipelines.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';

const { defineStage } = gatewayFactSpace<{}>();
const key = 'request.openaiChatCompletions';

export const applyRoleCompatibility = defineStage({
  name: 'openaiChatCompletions.apply-role-compatibility',
  through: {
    request: { needs: [key, 'serve.candidate'], provides: [key], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const { model, upstream } = facts['serve.candidate'];
      if (model.endpoints.openaiChatCompletions === undefined || !providerSupportsOperation(upstream.kind, 'openaiChatCompletions')) return facts;

      const flags = model.enabledFlags;
      const rewriteSystemToDeveloper = flags.includes('rewrite-system-to-developer');
      const rewriteDeveloperToSystem = flags.includes('rewrite-developer-to-system');
      const rewriteMidConvSystemToUser = flags.includes('rewrite-mid-conv-system-to-user');
      if (!rewriteSystemToDeveloper && !rewriteDeveloperToSystem && !rewriteMidConvSystemToUser) return facts;

      const payload = facts[key];
      let crossedLeadingSystemRun = false;
      const messages = payload.messages.map(message => {
        let mapped: OpenAIChatCompletionsMessage = message;
        if (rewriteSystemToDeveloper && mapped.role === 'system') mapped = { ...mapped, role: 'developer' };
        if (rewriteDeveloperToSystem && mapped.role === 'developer') mapped = { ...mapped, role: 'system' };
        if (mapped.role !== 'system') crossedLeadingSystemRun = true;
        if (rewriteMidConvSystemToUser && crossedLeadingSystemRun && mapped.role === 'system') mapped = { ...mapped, role: 'user' };
        return mapped;
      });
      return { ...facts, [key]: move({ ...payload, messages }) };
    },
  })),
});
