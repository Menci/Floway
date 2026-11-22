import { logWarn } from './log.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

export const STREAM_DIAGNOSTIC_FRAME_LIMIT = 3;
export const STREAM_DIAGNOSTIC_FRAME_DATA_CHARS = 256;

export interface StreamDiagnosticFrame {
  event: string | null;
  data: string;
}

const oneLineError = (error: unknown): string => {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  return message.length > 512 ? `${message.slice(0, 509)}...` : message;
};

export const observedClaudeCodeMessagesStream = async function* (
  events: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>,
  options: {
    upstreamId: string;
    model: string;
    headers: Headers;
    signal: AbortSignal | undefined;
    frames: StreamDiagnosticFrame[];
    rawFrameCount: () => number;
    warn?: (message: string, fields: Readonly<Record<string, unknown>>) => Promise<void>;
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
    if (options.signal?.aborted || (terminalEvent !== null && streamError === undefined)) return;
    const fields = {
      upstream_id: options.upstreamId,
      model: options.model,
      request_id: options.headers.get('request-id'),
      cf_ray: options.headers.get('cf-ray'),
      trace_response: options.headers.get('traceresponse'),
      raw_sse_frames: options.rawFrameCount(),
      terminal_event: terminalEvent,
      error: streamError === undefined ? null : oneLineError(streamError),
      last_sse_frames: JSON.stringify(options.frames),
    };
    if (options.warn === undefined) logWarn('claude_code_messages_stream_incomplete', fields);
    else await options.warn('claude_code_messages_stream_incomplete', fields);
  }
};
