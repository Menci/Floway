import type { PlaygroundApi, PlaygroundMessage } from './request';
import { errorMessageFromPayload } from '../../lib/error-payload';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { parseSSEStream } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { OPENAI_RESPONSES_LITE_HEADER, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

export interface PlaygroundRequest {
  api: PlaygroundApi;
  apiKey: string;
  model: string;
  system: string;
  messages: readonly PlaygroundMessage[];
  options: Record<string, unknown>;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}

const PATH_BY_API: Record<PlaygroundApi, string> = {
  anthropicMessages: '/v1/messages',
  openaiChatCompletions: '/v1/chat/completions',
  openaiResponses: '/v1/responses',
  openaiResponsesLite: '/v1/responses',
};

const isOpenAIResponses = (api: PlaygroundApi): boolean => api === 'openaiResponses' || api === 'openaiResponsesLite';

const contentFor = (message: PlaygroundMessage, api: PlaygroundApi): unknown => {
  if (!message.imageUrl) return message.text;
  if (api === 'anthropicMessages') {
    return [
      { type: 'text', text: message.text },
      { type: 'image', source: { type: 'url', url: message.imageUrl } },
    ];
  }
  if (isOpenAIResponses(api)) {
    return [
      { type: 'input_text', text: message.text },
      { type: 'input_image', image_url: message.imageUrl },
    ];
  }
  return [
    { type: 'text', text: message.text },
    { type: 'image_url', image_url: { url: message.imageUrl } },
  ];
};

const bodyFor = ({ api, model, system, messages, options }: PlaygroundRequest): unknown => {
  const turns = messages.map(message => ({ type: 'message' as const, role: message.role, content: contentFor(message, api) }));
  if (api === 'anthropicMessages') {
    return { model, stream: true, ...(system ? { system } : {}), messages: turns.map(({ type: _type, ...turn }) => turn), ...options };
  }
  if (api === 'openaiResponses' || api === 'openaiResponsesLite') {
    return { model, stream: true, ...(system ? { instructions: system } : {}), input: turns, ...options };
  }
  return {
    model,
    stream: true,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...turns.map(({ type: _type, ...turn }) => turn)],
    ...options,
  };
};

const textDelta = (api: PlaygroundApi, event: unknown): string => {
  if (api === 'openaiChatCompletions') {
    const chunk = event as OpenAIChatCompletionsStreamEvent;
    return chunk.choices?.[0]?.delta?.content ?? '';
  }
  if (api === 'anthropicMessages') {
    const anthropicMessagesEvent = event as AnthropicMessagesStreamEvent;
    if (anthropicMessagesEvent.type !== 'content_block_delta') return '';
    return anthropicMessagesEvent.delta.type === 'text_delta' ? anthropicMessagesEvent.delta.text : '';
  }
  const openaiResponsesEvent = event as OpenAIResponsesStreamEvent;
  return openaiResponsesEvent.type === 'response.output_text.delta' ? openaiResponsesEvent.delta : '';
};

const streamFailureMessage = (api: PlaygroundApi, payload: unknown): string | null => {
  const direct = errorMessageFromPayload(payload);
  if (direct !== null || !isOpenAIResponses(api) || !payload || typeof payload !== 'object') return direct;
  const event = payload as OpenAIResponsesStreamEvent;
  if (event.type !== 'response.failed') return null;
  return event.response.error?.message ?? 'Response failed';
};

// Wire shapes come from @floway-dev/protocols rather than a third-party client,
// which would hide the fields this gateway exists to carry.
export const streamPlaygroundText = async function* (request: PlaygroundRequest): AsyncGenerator<string> {
  const { api, apiKey, signal, fetchImpl } = request;
  const response = await fetchImpl(PATH_BY_API[api], {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // https://docs.anthropic.com/en/api/versioning
      ...(api === 'anthropicMessages' ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${apiKey}` }),
      ...(api === 'openaiResponsesLite' ? { [OPENAI_RESPONSES_LITE_HEADER]: 'true' } : {}),
    },
    body: JSON.stringify(bodyFor(request)),
    signal,
  });

  if (!response.ok || !response.body) {
    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(raw || `HTTP ${response.status}`);
    }
    throw new Error(errorMessageFromPayload(parsed) ?? (raw || `HTTP ${response.status}`));
  }

  for await (const frame of parseSSEStream(response.body, { signal })) {
    if (frame.data === '[DONE]') return;
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      continue;
    }
    const failure = streamFailureMessage(api, payload);
    if (failure !== null) throw new Error(failure);
    const delta = textDelta(api, payload);
    if (delta) yield delta;
  }
};
