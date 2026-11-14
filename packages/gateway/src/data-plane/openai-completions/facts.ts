import type { GatewayFacts, Failure } from '../pipeline/facts.ts';
import type { StreamOutcome } from '../pipeline/serve.ts';
import type { Deferred } from '@floway-dev/pipeline';
import type { ProtocolFrame, SseFrame } from '@floway-dev/protocols/common';
import type { OpenAICompletionsStreamEvent, OpenAICompletionsPayload, OpenAICompletionsResult } from '@floway-dev/protocols/openai-completions';

/** The answer while it is still the upstream's, one frame at a time. */
export type OpenAICompletionsFrames = AsyncIterable<ProtocolFrame<OpenAICompletionsStreamEvent>>;

/** OpenAI Completions' own keys, extending the shared space by intersection. */
export interface OpenAICompletionsFacts extends GatewayFacts {
  /** What the client asked for, which is not what the upstream is asked for: the gateway
   *  meters every stream and so always turns the usage chunk on. These stay put for the same
   *  reason every `ingress.*` key does — they describe the request that arrived, and the
   *  answer is rendered back into it. */
  'ingress.openaiCompletions.wantsStream': boolean;
  'ingress.openaiCompletions.wantsUsageChunk': boolean;
  'request.openaiCompletions.payload': OpenAICompletionsPayload;
  /** The answer, whichever kind it turned out to be. A stream, a value and a failure sit at
   *  one key: telling them apart is reading a value, and each stage does that where it needs
   *  to. */
  'response.openaiCompletions.payload': OpenAICompletionsResult | OpenAICompletionsFrames | Failure;
  /** What the upstream will have reported by the time the frames run out, and `null` on
   *  every path that does not stream. A stream's usage arrives with its last chunk, which is
   *  after this run has answered — so the numbers cannot be in `response.usage.billable`,
   *  which says what had been reported when the ending stage handed up: the entity, and no
   *  quantities. Settling billing from this is the prologue's job, after the drain. */
  'response.openaiCompletions.streamedUsage': Deferred<StreamOutcome> | null;
  /** What the client is actually sent, in its own protocol — a JSON body, or the SSE frames
   *  of a stream. The edge provides it, so a dump shows what the client received rather than
   *  the gateway's own reading of it. */
  'response.openaiCompletions.rendered': Record<string, unknown> | AsyncIterable<SseFrame>;
}

export type Fields<K extends keyof OpenAICompletionsFacts> = { [P in K]: OpenAICompletionsFacts[P] };
