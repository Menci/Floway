import type { IR, IRUsage } from './ir.ts';
import { createAnthropicMessagesUsage, splitAnthropicMessagesCacheCreationTokens } from '@floway-dev/protocols/anthropic-messages';
import { splitInclusiveInputTokens } from '@floway-dev/protocols/common';

export interface IRWire { [key: string]: any }

export const usageToIR = (protocol: 'openaiChatCompletions' | 'openaiResponses' | 'anthropicMessages', usage: IRWire): IRUsage => {
  const result: IRUsage = {};
  const put = (key: keyof IRUsage, value: number | undefined | null): void => { if (value != null) result[key] = value; };
  if (protocol === 'anthropicMessages') {
    const { cacheWrite, cacheWrite1h } = splitAnthropicMessagesCacheCreationTokens({
      ...(usage.cache_creation_input_tokens == null ? {} : { cache_creation_input_tokens: usage.cache_creation_input_tokens }),
      ...(usage.cache_creation == null ? {} : { cache_creation: usage.cache_creation }),
    });
    const write = cacheWrite + cacheWrite1h;
    if (usage.input_tokens != null) put('input_tokens_inclusive', usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + write);
    put('output_tokens_inclusive', usage.output_tokens);
    put('cached_input_tokens', usage.cache_read_input_tokens);
    if (usage.cache_creation_input_tokens != null || usage.cache_creation != null) put('cache_creation_input_tokens', write);
    put('reasoning_tokens', usage.output_tokens_details?.thinking_tokens);
  } else {
    const chat = protocol === 'openaiChatCompletions';
    put('input_tokens_inclusive', chat ? usage.prompt_tokens : usage.input_tokens);
    put('output_tokens_inclusive', chat ? usage.completion_tokens : usage.output_tokens);
    put('total_tokens', usage.total_tokens);
    const input = chat ? usage.prompt_tokens_details : usage.input_tokens_details;
    const output = chat ? usage.completion_tokens_details : usage.output_tokens_details;
    put('cached_input_tokens', input?.cached_tokens);
    put('cache_creation_input_tokens', input?.cache_creation_input_tokens ?? input?.cache_write_tokens);
    put('reasoning_tokens', output?.reasoning_tokens);
    put('input_audio_tokens', input?.audio_tokens);
    put('input_text_tokens', input?.text_tokens);
    put('input_image_tokens', input?.image_tokens);
    put('output_audio_tokens', output?.audio_tokens);
    put('output_text_tokens', output?.text_tokens);
  }
  if (result.input_tokens_inclusive !== undefined) splitInclusiveInputTokens(result.input_tokens_inclusive, result.cached_input_tokens ?? 0, result.cache_creation_input_tokens ?? 0);
  return result;
};

export const usageFromIR = (usage: IRUsage, protocol: 'openaiChatCompletions' | 'openaiResponses' | 'anthropicMessages' | 'geminiGenerateContent'): IRWire => {
  const input = usage.input_tokens_inclusive ?? 0;
  const output = usage.output_tokens_inclusive ?? 0;
  if (protocol === 'anthropicMessages') return {
    ...createAnthropicMessagesUsage(input - (usage.cached_input_tokens ?? 0) - (usage.cache_creation_input_tokens ?? 0), output),
    cache_read_input_tokens: usage.cached_input_tokens ?? null,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null,
    output_tokens_details: usage.reasoning_tokens === undefined ? null : { thinking_tokens: usage.reasoning_tokens },
  };
  if (protocol === 'geminiGenerateContent') return {
    promptTokenCount: input,
    candidatesTokenCount: output - (usage.reasoning_tokens ?? 0),
    totalTokenCount: usage.total_tokens ?? input + output,
    ...(usage.cached_input_tokens === undefined ? {} : { cachedContentTokenCount: usage.cached_input_tokens }),
    ...(usage.reasoning_tokens === undefined ? {} : { thoughtsTokenCount: usage.reasoning_tokens }),
    ...(['input', 'output'] as const).reduce<IRWire>((details, direction) => {
      const tokens = ['audio', 'image', 'text'].flatMap(modality => {
        const count = usage[`${direction}_${modality}_tokens` as keyof IRUsage];
        return count === undefined ? [] : [{ modality: modality.toUpperCase(), tokenCount: count }];
      });
      if (tokens.length > 0) details[direction === 'input' ? 'promptTokensDetails' : 'candidatesTokensDetails'] = tokens;
      return details;
    }, {}),
  };
  const chat = protocol === 'openaiChatCompletions';
  const inputDetails: IRWire = {};
  const outputDetails: IRWire = {};
  if (usage.cached_input_tokens !== undefined) inputDetails.cached_tokens = usage.cached_input_tokens;
  if (usage.cache_creation_input_tokens !== undefined) inputDetails[chat ? 'cache_creation_input_tokens' : 'cache_write_tokens'] = usage.cache_creation_input_tokens;
  if (usage.reasoning_tokens !== undefined) outputDetails.reasoning_tokens = usage.reasoning_tokens;
  if (chat) for (const modality of ['audio', 'image', 'text']) {
    const inputCount = usage[`input_${modality}_tokens` as keyof IRUsage];
    const outputCount = usage[`output_${modality}_tokens` as keyof IRUsage];
    if (inputCount !== undefined) inputDetails[`${modality}_tokens`] = inputCount;
    if (outputCount !== undefined) outputDetails[`${modality}_tokens`] = outputCount;
  }
  return {
    [chat ? 'prompt_tokens' : 'input_tokens']: input,
    [chat ? 'completion_tokens' : 'output_tokens']: output,
    total_tokens: usage.total_tokens ?? input + output,
    ...(Object.keys(inputDetails).length === 0 ? {} : { [chat ? 'prompt_tokens_details' : 'input_tokens_details']: inputDetails }),
    ...(Object.keys(outputDetails).length === 0 ? {} : { [chat ? 'completion_tokens_details' : 'output_tokens_details']: outputDetails }),
  };
};

export const irServiceTier = (state: IR): string | undefined => {
  const openai = state.extensions?.openaiResponses ?? state.extensions?.openaiChatCompletions;
  if (typeof openai?.service_tier === 'string') return openai.service_tier;
  const usage = state.extensions?.anthropicMessages?.usage as IRWire | undefined;
  if (usage?.speed === 'fast') return 'fast';
  return typeof usage?.service_tier === 'string' ? usage.service_tier : undefined;
};
