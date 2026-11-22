import { logWarn } from './log.ts';
import { Bytes, defineStage, type ManagedStream } from '@floway-dev/pipeline';
import { parseAnthropicMessagesStream, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { isEventStreamMediaType, type ProtocolFrame, type SseFrame } from '@floway-dev/protocols/common';
import type { HttpResponseFacts, ProviderHttpOutput, ProviderServices, ProviderStreamOutput } from '@floway-dev/provider';

const STREAM_DIAGNOSTIC_FRAME_LIMIT = 3;
const STREAM_DIAGNOSTIC_FRAME_DATA_CHARS = 256;
const ERROR_SNIPPET_CHARS = 1024;

const oneLineError = (error: unknown): string => {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  return message.length > 512 ? `${message.slice(0, 509)}...` : message;
};

interface StreamDiagnosticFrame {
  event: string | null;
  data: string;
}

const observedClaudeCodeMessagesStream = async function* (
  events: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>,
  options: {
    upstreamId: string;
    model: string;
    headers: Headers;
    signal: AbortSignal;
    frames: StreamDiagnosticFrame[];
    rawFrameCount: () => number;
  },
): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> {
  let terminalEvent: 'message_stop' | 'error' | null = null;
  let streamError: unknown;
  try {
    for await (const frame of events) {
      if (frame.type === 'event') {
        if (frame.event.type === 'message_stop') terminalEvent = 'message_stop';
        else if (frame.event.type === 'error') terminalEvent = 'error';
      }
      yield frame;
    }
  } catch (error) {
    streamError = error;
    throw error;
  } finally {
    if (!options.signal.aborted && (terminalEvent === null || streamError !== undefined)) logWarn('claude_code_messages_stream_incomplete', {
      upstream_id: options.upstreamId,
      model: options.model,
      request_id: options.headers.get('request-id'),
      cf_ray: options.headers.get('cf-ray'),
      trace_response: options.headers.get('traceresponse'),
      raw_sse_frames: options.rawFrameCount(),
      terminal_event: terminalEvent,
      error: streamError === undefined ? null : oneLineError(streamError),
      last_sse_frames: JSON.stringify(options.frames),
    });
  }
};

const readableBytes = (source: AsyncIterable<Bytes>): ReadableStream<Uint8Array> => {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const part = await iterator.next();
      if (part.done) controller.close();
      else controller.enqueue(part.value.toUint8Array());
    },
    async cancel() {
      await iterator.return?.();
    },
  }, { highWaterMark: 0 });
};

const bodySnippet = async (body: HttpResponseFacts['body']): Promise<string> => {
  const decoder = new TextDecoder();
  let text = body instanceof Bytes ? body.utf8() : '';
  if (body !== null && !(body instanceof Bytes)) {
    for await (const part of body) {
      text += decoder.decode(part.toUint8Array(), { stream: true });
      if (text.length > ERROR_SNIPPET_CHARS) break;
    }
    text += decoder.decode();
  }
  if (text.length === 0) return '<empty>';
  return text.length > ERROR_SNIPPET_CHARS ? `${text.slice(0, ERROR_SNIPPET_CHARS)}...[truncated]` : text;
};

const parseBody = (source: AsyncIterable<Bytes>, signal: AbortSignal, upstreamId: string, model: string, headers: Headers, requestSignal: AbortSignal) => {
  let rawSseFrames = 0;
  const frames: StreamDiagnosticFrame[] = [];
  const onSseFrame = (frame: SseFrame): void => {
    rawSseFrames++;
    frames.push({
      event: frame.event ?? null,
      data: frame.data.length > STREAM_DIAGNOSTIC_FRAME_DATA_CHARS
        ? `${frame.data.slice(0, STREAM_DIAGNOSTIC_FRAME_DATA_CHARS - 3)}...`
        : frame.data,
    });
    if (frames.length > STREAM_DIAGNOSTIC_FRAME_LIMIT) frames.shift();
  };
  return observedClaudeCodeMessagesStream(parseAnthropicMessagesStream(readableBytes(source), { signal, onSseFrame }), {
    upstreamId,
    model,
    headers,
    signal: requestSignal,
    frames,
    rawFrameCount: () => rawSseFrames,
  });
};

export const parseMessagesStage = (upstreamId: string) => defineStage<
  {}, {}, ProviderHttpOutput, ProviderStreamOutput<AnthropicMessagesStreamEventEx>, ProviderServices
>({
  name: 'claude-code.parse-messages',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: { needs: ['response.http', 'response.modelKey'], consumes: [], provides: ['response.http', 'response.events'] },
  },
  async execute(facts, next, env) {
    const back = await next(facts);
    const response = back['response.http'];
    if (response.status < 200 || response.status >= 300) return { ...back, 'response.events': undefined };
    const headers = new Headers(response.headers.map(([name, value]): [string, string] => [name, typeof value === 'string' ? value : value.reveal()]));
    const contentType = headers.get('content-type');
    const parse = (source: AsyncIterable<Bytes>, signal: AbortSignal) => parseBody(source, signal, upstreamId, back['response.modelKey'], headers, env.signal);
    const body = response.body;
    if (body === null || !isEventStreamMediaType(contentType)) {
      const message = `Upstream returned ${response.status} with content-type "${contentType ?? 'unknown'}" but stream is required (provider must force stream=true and return text/event-stream when response.ok).`;
      let snippet: string;
      try {
        snippet = await bodySnippet(body);
      } catch (cause) {
        throw new Error(`${message} Body: <unreadable>`, { cause });
      }
      throw new Error(`${message} Body: ${snippet}`);
    }

    const events: ManagedStream<ProtocolFrame<AnthropicMessagesStreamEventEx>> = body instanceof Bytes
      ? env.createStream({ label: 'claude-code.messages', iterate: signal => parse((async function* () { yield body; })(), signal) })
      : env.wrapStream(body, { label: 'claude-code.messages', transform: parse });
    return { ...back, 'response.http': { ...response, body: null }, 'response.events': events };
  },
});
