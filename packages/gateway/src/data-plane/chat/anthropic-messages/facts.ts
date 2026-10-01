import type { StreamOutcome } from '../../pipeline/serve.ts';
import type { ChatFacts } from '../facts.ts';
import type { Deferred } from '@floway-dev/pipeline';
import type { SseFrame } from '@floway-dev/protocols/common';

/** What this family adds to the chat space. */
export interface AnthropicMessagesFacts extends ChatFacts {
  /** What the client is actually sent — an object when it asked for one, SSE frames when it
   *  asked to stream. The edge provides it, so a dump shows what the client received. */
  'response.chat.anthropicMessages.rendered': Record<string, unknown> | AsyncIterable<SseFrame>;
  /** What the upstream will have reported once the frames run out, and `null` when nothing
   *  streamed. Settling from this is the epilogue's job, after the drain. */
  'response.chat.anthropicMessages.streamedUsage': Deferred<StreamOutcome> | null;
}

export type Fields<K extends keyof AnthropicMessagesFacts> = { [P in K]: AnthropicMessagesFacts[P] };

/** This family's own reading, which every wire under it hands up. */
export const STREAMED_USAGE = 'response.chat.anthropicMessages.streamedUsage';

export type AnthropicMessagesServeEntry = Fields<
  'ingress.http.headers' | 'ingress.chat.sourceProtocol' | 'ingress.chat.anthropicMessages.wantsStream'
  | 'request.chat.anthropicMessages' | 'serve.model'
>;

export type AnthropicMessagesServeExit = Fields<
  'response.chat.anthropicMessages.rendered' | 'response.chat.anthropicMessages.streamedUsage'
  | 'response.http.status' | 'response.http.jsonBody' | 'response.http.headers' | 'response.usage.billable'
>;
