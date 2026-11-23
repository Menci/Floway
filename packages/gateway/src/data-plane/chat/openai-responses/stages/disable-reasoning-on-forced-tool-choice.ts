import { responsesPayloadStage } from './facts.ts';

export const disableReasoningOnForcedToolChoice = responsesPayloadStage('disableReasoningOnForcedToolChoice', (payload, facts) => {
  if (!facts['route.candidate'].providerModel.enabledFlags.includes('disable-reasoning-on-forced-tool-choice')) return payload;
  const choice = payload.tool_choice;
  if (choice == null || typeof choice === 'string' && choice !== 'required') return payload;
  return { ...payload, reasoning: { effort: 'none' } };
});
