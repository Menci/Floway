
import type { ControlPlaneModel } from '../../api/types';
import { ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS } from '@floway-dev/protocols/anthropic-messages';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import { OPENAI_RESPONSES_LITE_HEADER, toLiteOpenAIResponsesPayload, type CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

export type PlaygroundApi = 'openaiResponses' | 'openaiResponsesLite' | 'openaiChatCompletions' | 'anthropicMessages';

export interface PlaygroundMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  imageUrl?: string;
}

export const playgroundApis: PlaygroundApi[] = ['openaiResponses', 'openaiResponsesLite', 'openaiChatCompletions', 'anthropicMessages'];

export const supportsImageInput = (model: ControlPlaneModel | null): boolean => {
  const modalities = model?.chat?.modalities?.input;
  return modalities === undefined || modalities.includes('image');
};

export const defaultMaxOutputTokens = (model: ControlPlaneModel | null): number => {
  const advertised = model?.limits.max_output_tokens;
  return advertised === undefined
    ? ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS
    : Math.min(advertised, ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS);
};

const reservedFields: Record<PlaygroundApi, readonly string[]> = {
  openaiChatCompletions: ['model', 'messages', 'stream'],
  openaiResponses: ['model', 'input', 'instructions', 'stream'],
  openaiResponsesLite: ['model', 'input', 'instructions', 'stream'],
  anthropicMessages: ['model', 'messages', 'system', 'stream'],
};

export type CustomJsonResult =
  | { value: Record<string, unknown>; error: null }
  | { value: null; error: 'invalid' | 'object' }
  | { value: null; error: 'reserved'; fields: string[] };

export const parseCustomJson = (api: PlaygroundApi, source: string): CustomJsonResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { value: null, error: 'invalid' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: 'object' };
  }
  const fields = reservedFields[api].filter(field => Object.hasOwn(parsed, field));
  if (fields.length) return { value: null, error: 'reserved', fields };
  return { value: parsed as Record<string, unknown>, error: null };
};

export const mergeWireBody = (body: BodyInit | null | undefined, custom: Record<string, unknown>): string => {
  if (typeof body !== 'string') throw new Error('Playground provider produced a non-JSON request body.');
  const generated = JSON.parse(body) as unknown;
  if (!generated || typeof generated !== 'object' || Array.isArray(generated)) {
    throw new Error('Playground provider produced an invalid request body.');
  }
  return JSON.stringify({ ...(generated as Record<string, unknown>), ...custom });
};

const normalizeAnthropicMessagesSseLine = (line: string): string => {
  if (!line.startsWith('data:')) return line;
  const source = line.slice(5).trimStart();
  try {
    const event = JSON.parse(source) as {
      type?: string;
      message?: { usage?: Record<string, unknown> };
    };
    if (event.type !== 'message_start' || !event.message) return line;
    const usage = event.message.usage ?? {};
    if (typeof usage.input_tokens !== 'number') usage.input_tokens = 0;
    event.message.usage = usage;
    return `data: ${JSON.stringify(event)}`;
  } catch {
    return line;
  }
};

const normalizeAnthropicMessagesStream = (response: Response): Response => {
  if (!response.body || !isEventStreamMediaType(response.headers.get('content-type'))) return response;
  let pending = '';
  const stream = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TransformStream<string, string>({
      transform(chunk, controller) {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) controller.enqueue(`${normalizeAnthropicMessagesSseLine(line)}\n`);
      },
      flush(controller) {
        if (pending) controller.enqueue(normalizeAnthropicMessagesSseLine(pending));
      },
    }))
    .pipeThrough(new TextEncoderStream());
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const normalizeOpenAIResponsesBody = (body: BodyInit | null | undefined): BodyInit | null | undefined => {
  if (typeof body !== 'string') return body;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.input)) return body;
    obj.input = (obj.input as unknown[]).map((item: unknown) => {
      if (item && typeof item === 'object' && 'role' in item && !('type' in item)) {
        return { type: 'message', ...(item as Record<string, unknown>) };
      }
      return item;
    });
    return JSON.stringify(obj);
  } catch {
    return body;
  }
};

export const createWireFetch = (custom: Record<string, unknown>, api?: PlaygroundApi): typeof fetch => {
  return async (input, init) => {
    const normalized = api === 'openaiResponses' || api === 'openaiResponsesLite' ? normalizeOpenAIResponsesBody(init?.body) : init?.body;
    const merged = mergeWireBody(normalized, custom);
    // Custom JSON is part of the canonical standard request. Convert only
    // after merging it so client tools cannot leak back onto Lite's top level.
    const body = api === 'openaiResponsesLite'
      ? JSON.stringify(toLiteOpenAIResponsesPayload(JSON.parse(merged) as CanonicalOpenAIResponsesPayload))
      : merged;
    const headers = api === 'openaiResponsesLite' ? new Headers(init?.headers) : init?.headers;
    if (headers instanceof Headers && api === 'openaiResponsesLite') headers.set(OPENAI_RESPONSES_LITE_HEADER, 'true');
    const response = await fetch(input, { ...init, headers, body });
    return api === 'anthropicMessages' ? normalizeAnthropicMessagesStream(response) : response;
  };
};

export const generationOptions = (
  api: PlaygroundApi,
  reasoningEffort: string | undefined,
  anthropicMessagesMaxTokens = ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS,
): Record<string, unknown> => {
  if (api === 'anthropicMessages') {
    return {
      max_tokens: anthropicMessagesMaxTokens,
      ...(reasoningEffort && {
        thinking: { type: 'enabled' },
        output_config: { effort: reasoningEffort },
      }),
    };
  }

  if (api === 'openaiResponses' || api === 'openaiResponsesLite') {
    return { ...(reasoningEffort && { reasoning: { effort: reasoningEffort } }) };
  }

  return { ...(reasoningEffort && { reasoning_effort: reasoningEffort }) };
};
