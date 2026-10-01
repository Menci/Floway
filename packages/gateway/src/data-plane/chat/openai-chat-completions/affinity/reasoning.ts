import type { AffinityEgressOptions } from '../../shared/affinity/index.ts';
import type { ChatCompletionsReasoningDataStandard, ReasoningRecord } from '@floway-dev/protocols/openai-chat-completions';

export interface ReasoningAffinitySlot {
  readonly field: 'reasoning_opaque' | 'reasoning_details' | 'thinking_blocks';
  readonly index?: number;
  readonly key?: 'data' | 'signature';
  readonly value: string;
  readonly domain: string;
}

export const reasoningAffinitySlots = (message: object): ReasoningAffinitySlot[] => {
  const wire = message as Record<string, unknown>;
  const slots: ReasoningAffinitySlot[] = [];
  if (typeof wire.reasoning_opaque === 'string') slots.push({ field: 'reasoning_opaque', value: wire.reasoning_opaque, domain: 'openai-chat-completions.reasoning_opaque' });
  for (const field of ['reasoning_details', 'thinking_blocks'] as const) {
    const members = wire[field];
    if (!Array.isArray(members)) continue;
    for (const [index, member] of members.entries()) {
      if (member === null || typeof member !== 'object') continue;
      const item = member as ReasoningRecord;
      const key = field === 'reasoning_details'
        ? item.type === 'reasoning.encrypted' ? 'data' : item.type === 'reasoning.text' ? 'signature' : undefined
        : item.type === 'redacted_thinking' ? 'data' : item.type === 'thinking' ? 'signature' : undefined;
      if (key !== undefined && typeof item[key] === 'string') slots.push({ field, index, key, value: item[key], domain: `openai-chat-completions.${field}.${item.type as string}.${key}` });
    }
  }
  return slots;
};

export const wrapChatCompletionsReasoningAffinity = async <T extends object>(
  message: T,
  options: AffinityEgressOptions,
  format: Exclude<ChatCompletionsReasoningDataStandard, 'passthrough'> = 'reasoning-opaque',
): Promise<T> => {
  const output = { ...message } as Record<string, unknown>;
  const slots = reasoningAffinitySlots(message);
  for (const field of ['reasoning_details', 'thinking_blocks'] as const) {
    if (Array.isArray(output[field])) output[field] = (output[field] as ReasoningRecord[]).map(item => ({ ...item }));
  }
  for (const slot of slots) {
    const value = await options.codec.wrap(slot.value, options.affinity, slot.domain);
    if (slot.index === undefined) output[slot.field] = value;
    else (output[slot.field] as ReasoningRecord[])[slot.index][slot.key!] = value;
  }
  if (slots.length === 0) {
    if (format === 'reasoning-opaque') output.reasoning_opaque = await options.codec.wrap(undefined, options.affinity, 'openai-chat-completions.reasoning_opaque');
    else {
      const field = format === 'openrouter-reasoning-details' ? 'reasoning_details' : 'thinking_blocks';
      const type = field === 'reasoning_details' ? 'reasoning.encrypted' : 'redacted_thinking';
      const data = await options.codec.wrap(undefined, options.affinity, `openai-chat-completions.${field}.${type}.data`, { syntheticItem: true });
      const item = field === 'reasoning_details' ? { type, data, format: 'unknown', id: `floway-affinity:${crypto.randomUUID()}` } : { type, data };
      output[field] = [...(output[field] as ReasoningRecord[] | undefined ?? []), item];
    }
  }
  return output as T;
};
