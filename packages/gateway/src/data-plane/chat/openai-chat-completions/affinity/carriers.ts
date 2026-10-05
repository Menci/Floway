import type { OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsReasoningPreference } from '@floway-dev/protocols/openai-chat-completions';

export const OPENAI_CHAT_COMPLETIONS_AFFINITY_DOMAIN = 'openai-chat-completions.reasoning_opaque';
export type ChatAffinityCarrier = { field: 'reasoning_opaque'; value: string } | { field: 'reasoning_details'; index: number; value: string };

export const chatAffinityCarriers = (value: OpenAIChatCompletionsAssistantMessageEx | OpenAIChatCompletionsAssistantDeltaEx, preference?: OpenAIChatCompletionsReasoningPreference): ChatAffinityCarrier[] => {
  const carriers: ChatAffinityCarrier[] = [];
  if ((preference === undefined || preference.reasoningEncapsulationFormat === 'copilot-reasoning_opaque') && typeof value.reasoning_opaque === 'string') carriers.push({ field: 'reasoning_opaque', value: value.reasoning_opaque });
  if ((preference === undefined || preference.reasoningEncapsulationFormat === 'openrouter-reasoning_details') && Array.isArray(value.reasoning_details)) {
    for (const [index, detail] of value.reasoning_details.entries()) {
      if (detail !== null && typeof detail === 'object' && detail.type === 'reasoning.encrypted' && typeof detail.data === 'string') carriers.push({ field: 'reasoning_details', index, value: detail.data });
    }
  }
  return carriers;
};

export const replaceChatAffinityCarriers = <T extends OpenAIChatCompletionsAssistantMessageEx | OpenAIChatCompletionsAssistantDeltaEx>(
  value: T,
  replacements: Array<{ carrier: ChatAffinityCarrier; value?: string }>,
): T => {
  if (replacements.length === 0) return value;
  const copy = { ...value };
  const details = Array.isArray(value.reasoning_details) ? [...value.reasoning_details] : undefined;
  const removed = new Set<number>();
  for (const replacement of replacements) {
    if (replacement.carrier.field === 'reasoning_opaque') {
      if (replacement.value === undefined) delete copy.reasoning_opaque;
      else copy.reasoning_opaque = replacement.value;
    } else {
      if (details === undefined) throw new Error('Reasoning detail carrier has no source array');
      if (replacement.value === undefined) removed.add(replacement.carrier.index);
      else details[replacement.carrier.index] = { ...details[replacement.carrier.index], data: replacement.value };
    }
  }
  if (details !== undefined) {
    const kept = details.filter((_detail, index) => !removed.has(index));
    if (kept.length > 0) copy.reasoning_details = kept;
    else delete copy.reasoning_details;
  }
  return copy;
};
