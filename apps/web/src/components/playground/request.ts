
import type { ControlPlaneModel } from '../../api/types';
import { MESSAGES_FALLBACK_MAX_TOKENS } from '@floway-dev/protocols/messages';

export type PlaygroundApi = 'responses' | 'chatCompletions' | 'messages';

export interface PlaygroundMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  imageUrl?: string;
}

export const playgroundApis: PlaygroundApi[] = ['responses', 'chatCompletions', 'messages'];

export const supportsImageInput = (model: ControlPlaneModel | null): boolean => {
  const modalities = model?.chat?.modalities?.input;
  return modalities === undefined || modalities.includes('image');
};

export const defaultMaxOutputTokens = (model: ControlPlaneModel | null): number => {
  const advertised = model?.limits.max_output_tokens;
  return advertised === undefined
    ? MESSAGES_FALLBACK_MAX_TOKENS
    : Math.min(advertised, MESSAGES_FALLBACK_MAX_TOKENS);
};

const reservedFields: Record<PlaygroundApi, readonly string[]> = {
  chatCompletions: ['model', 'messages', 'stream'],
  responses: ['model', 'input', 'instructions', 'stream'],
  messages: ['model', 'messages', 'system', 'stream'],
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

const normalizeMessagesSseLine = (line: string): string => {
  if (!line.startsWith('data:')) return line;
  const source = line.slice(5).trimStart();
  try {
    const event = JSON.parse(source) as {
      type?: string;
      message?: { usage?: Record<string, unknown> };
    };
    if (event.type !== 'message_start' || !event.message) return line;
    event.message.usage = {
      input_tokens: 0,
      ...event.message.usage,
    };
    return `data: ${JSON.stringify(event)}`;
  } catch {
    return line;
  }
};

const normalizeMessagesStream = (response: Response): Response => {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
  let pending = '';
  const stream = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TransformStream<string, string>({
      transform(chunk, controller) {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) controller.enqueue(`${normalizeMessagesSseLine(line)}\n`);
      },
      flush(controller) {
        if (pending) controller.enqueue(normalizeMessagesSseLine(pending));
      },
    }))
    .pipeThrough(new TextEncoderStream());
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const normalizeResponsesBody = (body: BodyInit | null | undefined): BodyInit | null | undefined => {
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
    const normalized = api === 'responses' ? normalizeResponsesBody(init?.body) : init?.body;
    const response = await fetch(input, { ...init, body: mergeWireBody(normalized, custom) });
    return api === 'messages' ? normalizeMessagesStream(response) : response;
  };
};

export const generationOptions = (
  api: PlaygroundApi,
  reasoningEffort: string | undefined,
  messagesMaxTokens = MESSAGES_FALLBACK_MAX_TOKENS,
): Record<string, unknown> => {
  if (api === 'messages') {
    return {
      max_tokens: messagesMaxTokens,
      ...(reasoningEffort && {
        thinking: { type: 'enabled' },
        output_config: { effort: reasoningEffort },
      }),
    };
  }

  if (api === 'responses') {
    return { ...(reasoningEffort && { reasoning: { effort: reasoningEffort } }) };
  }

  return { ...(reasoningEffort && { reasoning_effort: reasoningEffort }) };
};
