import { observedClaudeCodeMessagesStream, STREAM_DIAGNOSTIC_FRAME_DATA_CHARS, STREAM_DIAGNOSTIC_FRAME_LIMIT, type StreamDiagnosticFrame } from '../fetch.ts';
import type { ClaudeCodeHttpRequest } from '../pipeline-facts.ts';
import { exchangeResponse } from '@floway-dev/http/pipeline';
import { defineStage, move, setRelease } from '@floway-dev/pipeline';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import type { ProviderChatResponse, ProviderChatServices, ProviderResponse } from '@floway-dev/provider';

export const decodeClaudeCodeResponse = (upstreamId: string) => defineStage<ClaudeCodeHttpRequest, ClaudeCodeHttpRequest, ProviderResponse, ProviderChatResponse<'anthropicMessages'>, ProviderChatServices>({
  name: 'decodeClaudeCodeResponse',
  through: {
    request: { needs: ['request.provider.modelKey', 'request.http.callId'], consumes: [], provides: [] },
    response: { needs: ['response.http.exchange', 'response.http.body'], consumes: ['response.http.body'], provides: ['response.http.body', 'response.provider.output'] },
  },
  execute: async (facts, next, use) => {
    const back = await next(move({ ...facts }));
    const exchange = back['response.http.exchange'];
    if (exchange.type === 'transportFailure' || exchange.status < 200 || exchange.status >= 300) return move({ ...back, 'response.provider.output': null });
    const response = exchangeResponse(exchange);
    if (exchange.body === null || !isEventStreamMediaType(response.headers.get('content-type'))) {
      const text = await response.text();
      if (exchange.body !== null) setRelease(exchange.body, async () => {});
      let body: unknown;
      try { body = JSON.parse(text); } catch (error) { if (!(error instanceof SyntaxError)) throw error; body = text; }
      const snippet = text.length === 0 ? '<empty>' : text.length > 1024 ? `${text.slice(0, 1024)}...[truncated]` : text;
      return move({ ...back, 'response.provider.output': { status: 502, message: `Upstream returned ${exchange.status} with content-type "${response.headers.get('content-type') ?? 'unknown'}" but stream is required (provider must force stream=true and return text/event-stream when response.ok). Body: ${snippet}`, body } });
    }
    const signal = use.httpCall(facts['request.http.callId']).signal;
    let rawFrameCount = 0;
    const samples: StreamDiagnosticFrame[] = [];
    const parsed = use.recordProtocolFrames(parseAnthropicMessagesStream(exchange.body, {
      signal, onSseFrame: frame => {
        rawFrameCount++;
        samples.push({ event: frame.event ?? null, data: frame.data.length > STREAM_DIAGNOSTIC_FRAME_DATA_CHARS ? `${frame.data.slice(0, STREAM_DIAGNOSTIC_FRAME_DATA_CHARS - 3)}...` : frame.data });
        if (samples.length > STREAM_DIAGNOSTIC_FRAME_LIMIT) samples.shift();
      },
    }));
    const frames = use.recordProtocolFrames(observedClaudeCodeMessagesStream(parsed, { upstreamId, model: facts['request.provider.modelKey'], headers: response.headers, signal, frames: samples, rawFrameCount: () => rawFrameCount, warn: use.log.warn }));
    return move({ ...back, 'response.provider.output': { kind: 'stream' as const, frames } });
  },
});
