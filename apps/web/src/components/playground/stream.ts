import type { PlaygroundApi, PlaygroundAssistantOutput, PlaygroundMessage } from './request';
import { errorMessageFromPayload } from '../../lib/error-payload';
import {
  type GeminiGenerateContentPart,
  reassembleGeminiGenerateContentEvents,
  type GeminiGenerateContentStreamEvent,
  reassembleAnthropicMessagesEvents,
  type AnthropicMessagesStreamEventEx,
  parseSSEStream,
  reassembleOpenAIChatCompletionsEvents,
  type OpenAIChatCompletionsStreamEvent,
  reassembleOpenAIResponsesEvents,
  type OpenAIResponsesStreamEventEx,
} from '@floway-dev/protocols/browser';

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
  geminiGenerateContent: '/v1beta/models',
  openaiChatCompletions: '/v1/chat/completions',
  openaiResponses: '/v1/responses',
};

// GenerateContent puts the model and the action in one path segment.
const pathFor = (request: PlaygroundRequest): string =>
  request.api === 'geminiGenerateContent'
    ? `${PATH_BY_API.geminiGenerateContent}/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`
    : PATH_BY_API[request.api];

// GenerateContent carries an image the way its own clients do: base64 bytes
// inline, or a URL the upstream fetches itself.
// https://ai.google.dev/gemini-api/docs/generate-content/file-input-methods
const geminiImagePart = (imageUrl: string): GeminiGenerateContentPart => {
  const inline = /^data:([^;,]+);base64,(.*)$/s.exec(imageUrl);
  return inline ? { inlineData: { mimeType: inline[1], data: inline[2] } } : { fileData: { fileUri: imageUrl } };
};

const geminiPartsFor = (message: PlaygroundMessage): GeminiGenerateContentPart[] =>
  message.imageUrl ? [{ text: message.text }, geminiImagePart(message.imageUrl)] : [{ text: message.text }];

const contentFor = (message: PlaygroundMessage, api: PlaygroundApi): unknown => {
  if (api === 'geminiGenerateContent') return geminiPartsFor(message);
  if (!message.imageUrl) return message.text;
  if (api === 'anthropicMessages') {
    return [
      { type: 'text', text: message.text },
      { type: 'image', source: { type: 'url', url: message.imageUrl } },
    ];
  }
  if (api === 'openaiResponses') {
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

const turnsFor = (messages: readonly PlaygroundMessage[], api: PlaygroundApi): unknown[] =>
  messages.flatMap<unknown>(message => {
    const output = message.role === 'assistant' ? message.assistantOutput : undefined;
    if (output?.api === api) {
      if (output.api === 'openaiResponses') return output.items;
      if (output.api === 'openaiChatCompletions') return [output.message];
      if (output.api === 'geminiGenerateContent') return [{ role: 'model', parts: output.parts }];
      return [{ role: 'assistant', content: output.content }];
    }
    if (api === 'geminiGenerateContent') {
      return [{ role: message.role === 'assistant' ? 'model' : 'user', parts: contentFor(message, api) }];
    }
    return [{ role: message.role, content: contentFor(message, api) }];
  });

const bodyFor = ({ api, model, system, messages, options }: PlaygroundRequest): unknown => {
  const turns = turnsFor(messages, api);
  if (api === 'anthropicMessages') {
    return { model, stream: true, ...(system ? { system } : {}), messages: turns, ...options };
  }
  if (api === 'openaiResponses') {
    return { model, stream: true, ...(system ? { instructions: system } : {}), input: turns, ...options };
  }
  if (api === 'geminiGenerateContent') {
    // The model and the streaming action live in the path, not the body.
    return {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: turns,
      ...options,
    };
  }
  return {
    model,
    stream: true,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...turns],
    ...options,
  };
};

const eventsFrom = async function*<T>(events: readonly T[]): AsyncGenerator<T> {
  yield* events;
};

const assistantOutputFrom = async (
  api: PlaygroundApi,
  events: readonly unknown[],
): Promise<PlaygroundAssistantOutput | null> => {
  if (events.length === 0) return null;
  if (api === 'openaiResponses') {
    const result = await reassembleOpenAIResponsesEvents(eventsFrom(events as OpenAIResponsesStreamEventEx[]));
    return { api: 'openaiResponses', items: result.output };
  }
  if (api === 'openaiChatCompletions') {
    const result = await reassembleOpenAIChatCompletionsEvents(eventsFrom(events as OpenAIChatCompletionsStreamEvent[]));
    const message = result.choices[0]?.message;
    return message ? { api: 'openaiChatCompletions', message } : null;
  }
  if (api === 'geminiGenerateContent') {
    const result = await reassembleGeminiGenerateContentEvents(
      eventsFrom(events as GeminiGenerateContentStreamEvent[]),
    );
    const parts = result.candidates?.[0]?.content?.parts;
    return parts ? { api: 'geminiGenerateContent', parts } : null;
  }
  const result = await reassembleAnthropicMessagesEvents(eventsFrom(events as AnthropicMessagesStreamEventEx[]));
  return { api: 'anthropicMessages', content: result.content };
};

const textDelta = (api: PlaygroundApi, event: unknown): string => {
  if (api === 'geminiGenerateContent') {
    const chunk = event as GeminiGenerateContentStreamEvent;
    if ('error' in chunk) return '';
    // Thought parts are model output too, but the playground renders
    // the answer; thought summaries would otherwise interleave with it.
    return (chunk.candidates?.[0]?.content?.parts ?? [])
      .filter(part => part.thought !== true)
      .map(part => part.text ?? '')
      .join('');
  }
  if (api === 'openaiChatCompletions') {
    const chunk = event as OpenAIChatCompletionsStreamEvent;
    return chunk.choices?.[0]?.delta?.content ?? '';
  }
  if (api === 'anthropicMessages') {
    const anthropicMessagesEvent = event as AnthropicMessagesStreamEventEx;
    if (anthropicMessagesEvent.type !== 'content_block_delta') return '';
    return anthropicMessagesEvent.delta.type === 'text_delta' ? anthropicMessagesEvent.delta.text : '';
  }
  const openaiResponsesEvent = event as OpenAIResponsesStreamEventEx;
  return openaiResponsesEvent.type === 'response.output_text.delta' ? openaiResponsesEvent.delta : '';
};

const streamFailureMessage = (api: PlaygroundApi, payload: unknown): string | null => {
  const direct = errorMessageFromPayload(payload);
  if (direct !== null || api !== 'openaiResponses' || !payload || typeof payload !== 'object') return direct;
  const event = payload as OpenAIResponsesStreamEventEx;
  if (event.type !== 'response.failed') return null;
  return event.response.error?.message ?? 'Response failed';
};

// Wire shapes come from @floway-dev/protocols rather than a third-party client,
// which would hide the fields this gateway exists to carry.
export const streamPlaygroundText = async function* (
  request: PlaygroundRequest,
): AsyncGenerator<string, PlaygroundAssistantOutput | null> {
  const { api, apiKey, signal, fetchImpl } = request;
  const response = await fetchImpl(pathFor(request), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Each protocol presents the gateway key the way its own clients do.
      // https://docs.anthropic.com/en/api/versioning
      // https://ai.google.dev/gemini-api/docs/api-key
      ...(api === 'anthropicMessages'
        ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
        : api === 'geminiGenerateContent'
          ? { 'x-goog-api-key': apiKey }
          : { authorization: `Bearer ${apiKey}` }),
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

  const events: unknown[] = [];
  for await (const frame of parseSSEStream(response.body, { signal })) {
    if (frame.data === '[DONE]') break;
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      continue;
    }
    const failure = streamFailureMessage(api, payload);
    if (failure !== null) throw new Error(failure);
    events.push(payload);
    const delta = textDelta(api, payload);
    if (delta) yield delta;
  }

  return await assistantOutputFrom(api, events);
};
