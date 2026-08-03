import type { PlaygroundApi, PlaygroundMessage } from './request';
import { errorMessageFromPayload } from '../../lib/error-payload';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { parseSSEStream } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';

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
  messages: '/v1/messages',
  chatCompletions: '/v1/chat/completions',
  responses: '/v1/responses',
};

const contentFor = (message: PlaygroundMessage, api: PlaygroundApi): unknown => {
  if (!message.imageUrl) return message.text;
  if (api === 'messages') {
    return [
      { type: 'text', text: message.text },
      { type: 'image', source: { type: 'url', url: message.imageUrl } },
    ];
  }
  if (api === 'responses') {
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
  const turns = messages.map(message => ({ role: message.role, content: contentFor(message, api) }));
  if (api === 'messages') {
    return { model, stream: true, ...(system ? { system } : {}), messages: turns, ...options };
  }
  if (api === 'responses') {
    return { model, stream: true, ...(system ? { instructions: system } : {}), input: turns, ...options };
  }
  return {
    model,
    stream: true,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...turns],
    ...options,
  };
};

const textDelta = (api: PlaygroundApi, event: unknown): string => {
  if (api === 'chatCompletions') {
    const chunk = event as ChatCompletionsStreamEvent;
    return chunk.choices?.[0]?.delta?.content ?? '';
  }
  if (api === 'messages') {
    const messagesEvent = event as MessagesStreamEvent;
    if (messagesEvent.type !== 'content_block_delta') return '';
    return messagesEvent.delta.type === 'text_delta' ? messagesEvent.delta.text : '';
  }
  const responsesEvent = event as ResponsesStreamEvent;
  return responsesEvent.type === 'response.output_text.delta' ? responsesEvent.delta : '';
};

const streamFailureMessage = (api: PlaygroundApi, payload: unknown): string | null => {
  const direct = errorMessageFromPayload(payload);
  if (direct !== null || api !== 'responses' || !payload || typeof payload !== 'object') return direct;
  const event = payload as ResponsesStreamEvent;
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
      ...(api === 'messages' ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${apiKey}` }),
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
