import { defineStage } from '../../pipeline/facts.ts';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
import type { FlagId } from '@floway-dev/upstream';

export const rewriteOpenAIResponsesRoles = (
  items: CanonicalOpenAIResponsesInputItem[], flags: readonly FlagId[],
): CanonicalOpenAIResponsesInputItem[] => {
  const systemToDeveloper = flags.includes('rewrite-system-to-developer');
  const developerToSystem = flags.includes('rewrite-developer-to-system');
  const midConversationSystemToUser = flags.includes('rewrite-mid-conv-system-to-user');
  if (!systemToDeveloper && !developerToSystem && !midConversationSystemToUser) return items;

  let crossedLeadingSystemRun = false;
  let changed = false;
  const input = items.map(item => {
    let mapped = item;
    if (mapped.type === 'message' && systemToDeveloper && mapped.role === 'system') mapped = { ...mapped, role: 'developer' };
    if (mapped.type === 'message' && developerToSystem && mapped.role === 'developer') mapped = { ...mapped, role: 'system' };
    if (mapped.type !== 'message' || mapped.role !== 'system') crossedLeadingSystemRun = true;
    if (midConversationSystemToUser && crossedLeadingSystemRun && mapped.type === 'message' && mapped.role === 'system') {
      mapped = { ...mapped, role: 'user' };
    }
    changed ||= mapped !== item;
    return mapped;
  });
  return changed ? input : items;
};

export const applyOpenAIResponsesRoleCompatibility = defineStage({
  name: 'openaiResponses.apply-role-compatibility',
  through: {
    request: { needs: ['openaiResponses', 'model'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiResponses;
    const input = rewriteOpenAIResponsesRoles(payload.input, facts.model.enabledFlags);
    if (input === payload.input) return await scope.next(facts);
    return await scope.next({ ...facts, openaiResponses: { ...payload, input } });
  },
});
