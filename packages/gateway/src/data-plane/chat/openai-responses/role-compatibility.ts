import { defineStage } from '../../pipeline/facts.ts';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
import type { FlagId } from '@floway-dev/provider';

export const rewriteOpenAIResponsesRoles = (
  items: CanonicalOpenAIResponsesInputItem[],
  flags: readonly FlagId[],
): CanonicalOpenAIResponsesInputItem[] => {
  const systemToDeveloper = flags.includes('rewrite-system-to-developer');
  const developerToSystem = flags.includes('rewrite-developer-to-system');
  const midConversationSystemToUser = flags.includes('rewrite-mid-conv-system-to-user');
  if (!systemToDeveloper && !developerToSystem && !midConversationSystemToUser) return items;

  let crossedLeadingSystemRun = false;
  let changed = false;
  const input = items.map((item): CanonicalOpenAIResponsesInputItem => {
    if (item.type !== 'message') {
      crossedLeadingSystemRun = true;
      return item;
    }
    let role = item.role;
    if (systemToDeveloper && role === 'system') role = 'developer';
    if (developerToSystem && role === 'developer') role = 'system';
    if (role !== 'system') crossedLeadingSystemRun = true;
    if (midConversationSystemToUser && crossedLeadingSystemRun && role === 'system') role = 'user';
    if (role === item.role) return item;
    changed = true;
    return { ...item, role } as CanonicalOpenAIResponsesInputItem;
  });
  return changed ? input : items;
};

export const applyOpenAIResponsesRoleCompatibility = defineStage({
  name: 'openaiResponses.apply-role-compatibility',
  through: {
    request: { needs: ['request.openaiResponses', 'provider.model'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['request.openaiResponses'];
    const input = rewriteOpenAIResponsesRoles(payload.input, facts['provider.model'].enabledFlags);
    return await scope.next({
      ...facts,
      'request.openaiResponses': input === payload.input ? payload : { ...payload, input },
    });
  },
});
