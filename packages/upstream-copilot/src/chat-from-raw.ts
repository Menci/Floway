import type { CopilotRawModel } from './types.ts';
import type { UpstreamChatModelConfig } from '@floway-dev/upstream';

export const chatFromCopilotRaw = (raw: CopilotRawModel): UpstreamChatModelConfig | undefined => {
  const supports = raw.capabilities?.supports;
  if (!supports) return undefined;

  const chat: UpstreamChatModelConfig = {};

  if (supports.vision === true) {
    chat.modalities = { input: ['text', 'image'], output: ['text'] };
  }

  const reasoning: NonNullable<UpstreamChatModelConfig['reasoning']> = {};
  const efforts = supports.reasoning_effort;
  if (efforts && efforts.length > 0) {
    const def = efforts.includes('medium') ? 'medium' : efforts[0];
    reasoning.effort = { supported: efforts, default: def };
  }
  const minBudget = supports.min_thinking_budget;
  const maxBudget = supports.max_thinking_budget;
  if (minBudget !== undefined || maxBudget !== undefined) {
    reasoning.budget_tokens = {
      ...(minBudget !== undefined ? { min: minBudget } : {}),
      ...(maxBudget !== undefined ? { max: maxBudget } : {}),
    };
  }
  if (supports.adaptive_thinking === true) {
    reasoning.adaptive = true;
  }

  if (Object.keys(reasoning).length > 0) chat.reasoning = reasoning;

  return Object.keys(chat).length > 0 ? chat : undefined;
};
