import type { IRUsage } from './ir.ts';

export interface IRWire { [key: string]: any }

export const usageToIR = (protocol: 'openaiChatCompletions' | 'openaiResponses' | 'anthropicMessages', usage: IRWire): IRUsage => {
  const result: IRUsage = {};
  const put = (key: keyof IRUsage, value: number | undefined | null): void => { if (value != null) result[key] = value; };
  if (protocol === 'anthropicMessages') {
    if (usage.input_tokens != null) put('input_tokens_inclusive', usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0));
    put('output_tokens_inclusive', usage.output_tokens);
    put('cached_input_tokens', usage.cache_read_input_tokens);
    put('cache_creation_input_tokens', usage.cache_creation_input_tokens);
  } else {
    const chat = protocol === 'openaiChatCompletions';
    put('input_tokens_inclusive', chat ? usage.prompt_tokens : usage.input_tokens);
    put('output_tokens_inclusive', chat ? usage.completion_tokens : usage.output_tokens);
    put('total_tokens', usage.total_tokens);
    const input = chat ? usage.prompt_tokens_details : usage.input_tokens_details;
    const output = chat ? usage.completion_tokens_details : usage.output_tokens_details;
    put('cached_input_tokens', input?.cached_tokens);
    put('cache_creation_input_tokens', input?.cache_creation_input_tokens);
    put('reasoning_tokens', output?.reasoning_tokens);
    put('input_audio_tokens', input?.audio_tokens);
    put('input_text_tokens', input?.text_tokens);
    put('input_image_tokens', input?.image_tokens);
    put('output_audio_tokens', output?.audio_tokens);
    put('output_text_tokens', output?.text_tokens);
  }
  return result;
};

export const usageFromIR = (usage: IRUsage, protocol: 'openaiChatCompletions' | 'openaiResponses' | 'anthropicMessages' | 'geminiGenerateContent'): IRWire => {
  if (protocol === 'anthropicMessages') return {
    input_tokens: (usage.input_tokens_inclusive ?? 0) - (usage.cached_input_tokens ?? 0) - (usage.cache_creation_input_tokens ?? 0),
    output_tokens: usage.output_tokens_inclusive ?? 0,
    cache_read_input_tokens: usage.cached_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
  };
  if (protocol === 'geminiGenerateContent') return {
    promptTokenCount: usage.input_tokens_inclusive ?? 0,
    candidatesTokenCount: (usage.output_tokens_inclusive ?? 0) - (usage.reasoning_tokens ?? 0),
    totalTokenCount: usage.total_tokens ?? ((usage.input_tokens_inclusive ?? 0) + (usage.output_tokens_inclusive ?? 0)),
    cachedContentTokenCount: usage.cached_input_tokens ?? 0,
    thoughtsTokenCount: usage.reasoning_tokens ?? 0,
    promptTokensDetails: ['audio', 'image', 'text'].flatMap(modality => {
      const count = usage[`input_${modality}_tokens` as keyof IRUsage];
      return count === undefined ? [] : [{ modality: modality.toUpperCase(), tokenCount: count }];
    }),
    candidatesTokensDetails: ['audio', 'text'].flatMap(modality => {
      const count = usage[`output_${modality}_tokens` as keyof IRUsage];
      return count === undefined ? [] : [{ modality: modality.toUpperCase(), tokenCount: count }];
    }),
  };
  const chat = protocol === 'openaiChatCompletions';
  return {
    [chat ? 'prompt_tokens' : 'input_tokens']: usage.input_tokens_inclusive ?? 0,
    [chat ? 'completion_tokens' : 'output_tokens']: usage.output_tokens_inclusive ?? 0,
    total_tokens: usage.total_tokens ?? ((usage.input_tokens_inclusive ?? 0) + (usage.output_tokens_inclusive ?? 0)),
    [chat ? 'prompt_tokens_details' : 'input_tokens_details']: { cached_tokens: usage.cached_input_tokens ?? 0, ...(chat && usage.input_audio_tokens !== undefined ? { audio_tokens: usage.input_audio_tokens } : {}) },
    [chat ? 'completion_tokens_details' : 'output_tokens_details']: { reasoning_tokens: usage.reasoning_tokens ?? 0, ...(chat && usage.output_audio_tokens !== undefined ? { audio_tokens: usage.output_audio_tokens } : {}) },
  };
};
