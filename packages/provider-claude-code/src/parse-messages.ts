import { logWarn } from './log.ts';
import type { ClaudeCodeServices } from './service.ts';
import { defineStage, isManagedStream } from '@floway-dev/pipeline';
import { parseAnthropicMessagesStream, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame, SseFrame } from '@floway-dev/protocols/common';
import { getHeader, parseErrorBody, parseSseBody, type HttpResponseFacts, type ProviderAnthropicMessagesOutput, type ProviderStreamParser, type ProviderUpstreamBase } from '@floway-dev/provider';

const STREAM_DIAGNOSTIC_FRAME_LIMIT = 3;
const STREAM_DIAGNOSTIC_FRAME_DATA_CHARS = 256;

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
    headers: HttpResponseFacts['headers'];
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
      request_id: getHeader(options.headers, 'request-id') ?? null,
      cf_ray: getHeader(options.headers, 'cf-ray') ?? null,
      trace_response: getHeader(options.headers, 'traceresponse') ?? null,
      raw_sse_frames: options.rawFrameCount(),
      terminal_event: terminalEvent,
      error: streamError === undefined ? null : oneLineError(streamError),
      last_sse_frames: JSON.stringify(options.frames),
    });
  }
};

const parseBody = (
  upstreamId: string, model: string, headers: HttpResponseFacts['headers'], requestSignal: AbortSignal,
): ProviderStreamParser<AnthropicMessagesStreamEventEx> => (source, options) => {
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
  return observedClaudeCodeMessagesStream(parseAnthropicMessagesStream(source, { ...options, onSseFrame }), {
    upstreamId,
    model,
    headers,
    signal: requestSignal,
    frames,
    rawFrameCount: () => rawSseFrames,
  });
};

type ParseInput = {
  readonly 'provider.upstream': ProviderUpstreamBase;
  readonly 'request.claudeCode.modelKey': string;
  readonly 'request.claudeCode.retryUnauthorized': boolean;
};
type HttpOutput = { readonly 'response.http': HttpResponseFacts };
type ParseOutput = Omit<ProviderAnthropicMessagesOutput, 'response.modelKey'>;

export const parseMessagesStage = defineStage<ParseInput, ParseInput, HttpOutput, ParseOutput, ClaudeCodeServices>({
  name: 'claude-code.parse-messages',
  through: {
    request: { needs: ['provider.upstream', 'request.claudeCode.modelKey', 'request.claudeCode.retryUnauthorized'], consumes: [], provides: [] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.http', 'response.anthropicMessages'] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const response = back['response.http'];
    const retry = response.status === 401 && facts['request.claudeCode.retryUnauthorized'];
    // Close the rejected attempt before refreshing, even if its body stalls.
    if (retry && isManagedStream(response.body)) await response.body.close();
    const failure = await parseErrorBody(retry ? { ...response, body: null } : response, scope);
    const parsed = failure ?? await parseSseBody(response, scope, parseBody(
      facts['provider.upstream'].id, facts['request.claudeCode.modelKey'], response.headers, scope.signal,
    ));
    return { ...back, 'response.http': parsed['response.http'], 'response.anthropicMessages': parsed.outcome };
  },
});
