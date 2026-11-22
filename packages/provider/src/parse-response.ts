import type { ProviderResponsesInput, ProviderServices } from './pipelines.ts';
import { openByteStream, readHttpBody, type HttpOutput } from './response-body.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { Bytes, defineStage, type ManagedStream } from '@floway-dev/pipeline';
import { isEventStreamMediaType, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesCompactionResultEx } from '@floway-dev/protocols/openai-responses';

export type ProviderStreamParser<Event> = (
  body: ReadableStream<Uint8Array>,
  options?: { signal?: AbortSignal },
) => AsyncIterable<ProtocolFrame<Event>>;

interface ParseCondition<Input> {
  readonly needs: readonly (keyof Input & string)[];
  readonly when: (facts: Input) => boolean;
}

const successful = ({ status }: HttpResponseFacts): boolean => status >= 200 && status < 300;
const bodySnippetChars = 1024;

const formatSnippet = (text: string): string => {
  if (text.length === 0) return '<empty>';
  return text.length > bodySnippetChars ? `${text.slice(0, bodySnippetChars)}...[truncated]` : text;
};

const bodySnippet = async (body: HttpResponseFacts['body']): Promise<string> => {
  if (body === null) return '<empty>';
  if (body instanceof Bytes) return formatSnippet(body.utf8());
  const decoder = new TextDecoder();
  let text = '';
  for await (const part of body) {
    text += decoder.decode(part.toUint8Array(), { stream: true });
    if (text.length > bodySnippetChars) return formatSnippet(text);
  }
  return formatSnippet(text + decoder.decode());
};

const requireEventStream = async (response: HttpResponseFacts): Promise<NonNullable<HttpResponseFacts['body']>> => {
  const header = response.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  const contentType = typeof header === 'string' ? header : header?.reveal() ?? '';
  if (response.body !== null && isEventStreamMediaType(contentType)) return response.body;
  const message = `Upstream returned ${response.status} with content-type "${contentType || 'unknown'}" but stream is required (provider must force stream=true and return text/event-stream when response.ok).`;
  let snippet: string;
  try {
    snippet = await bodySnippet(response.body);
  } catch (cause) {
    throw new Error(`${message} Body: <unreadable>`, { cause });
  }
  throw new Error(`${message} Body: ${snippet}`);
};

export const parseSseStage = <Event, Input = {}>(
  name: string,
  parser: ProviderStreamParser<Event>,
  condition?: ParseCondition<Input>,
) => defineStage<Input, Input, HttpOutput, HttpOutput & { readonly 'response.events': ManagedStream<ProtocolFrame<Event>> | undefined }, ProviderServices>({
  name,
  through: {
    request: { needs: condition?.needs ?? [], consumes: [], provides: [] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.http', 'response.events'] },
  },
  async execute(facts, next, env) {
    const back = await next(facts);
    const response = back['response.http'];
    if (!successful(response) || (condition && !condition.when(facts))) return { ...back, 'response.events': undefined };
    const body = await requireEventStream(response);
    const parse = (source: AsyncIterable<Bytes>, signal: AbortSignal) => parser(openByteStream(source).stream, { signal });
    const events = body instanceof Bytes
      ? env.createStream({ label: 'http.events', iterate: signal => parse((async function* () { yield body; })(), signal) })
      : env.wrapStream(body, { label: 'http.events', transform: parse });
    return { ...back, 'response.http': { ...response, body: null }, 'response.events': events };
  },
});

export const parseCompactionStage = (name = 'parseCompaction') => defineStage<
  ProviderResponsesInput, ProviderResponsesInput, HttpOutput,
  HttpOutput & { readonly 'response.result': OpenAIResponsesCompactionResultEx | undefined },
  ProviderServices
>({
  name,
  through: {
    request: { needs: ['request.action'], consumes: [], provides: [] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.http', 'response.result'] },
  },
  async execute(facts, next) {
    const back = await next(facts);
    const response = back['response.http'];
    if (facts['request.action'] !== 'compact' || !successful(response)) return { ...back, 'response.result': undefined };
    const result: OpenAIResponsesCompactionResultEx = JSON.parse((await readHttpBody(response.body)).utf8());
    return { ...back, 'response.http': { ...response, body: null }, 'response.result': result };
  },
});
