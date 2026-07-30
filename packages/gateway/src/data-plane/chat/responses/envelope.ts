import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  CanonicalResponsesPayload,
  ClientResponsesCompaction,
  ClientResponsesEnvelope,
  ClientResponsesReasoning,
  ClientResponsesStreamEvent,
  ClientResponsesTextField,
  ClientResponsesTool,
  ClientResponsesUsage,
  ResponsesResult,
  ResponsesStreamEvent,
  ResponsesTool,
} from '@floway-dev/protocols/responses';

// ── The policy boundary ──
//
// Interior stages never state a value they did not observe. The egress stage is
// the only place Floway states one, and only where the wire schema forbids both
// omission and `null`.
//
// The other half of that rule lives in the server-tool shim, where
// `upstreamResponseSnapshot` throws rather than fabricate an envelope it never
// captured — 44322150d (#125) reasoned that "the spec defaults observed via
// Azure echo (all 'auto') signal 'backend decides' rather than canonical values
// worth synthesizing", and shipped "absent-echo (no tools synthesized when
// upstream omits it)". The two rules do not conflict on any key, because they
// answer different questions:
//
// - The shim's snapshot is interior. Its output re-enters Floway: it becomes
//   the prologue and terminal envelope of a stitched multi-call turn, later
//   shim logic reads it, and its items are persisted. A value invented there is
//   indistinguishable from an observed one for every later reader.
// - This stage is terminal. Its output is serialized and never read again by
//   Floway. `commitSnapshot` persists ordered item ids only and runs strictly
//   before completion, so nothing invented here is ever stored; affinity egress
//   and telemetry likewise run below it. Nothing downstream can mistake a
//   stated default for an observation, because nothing downstream is Floway.
//
// #125's "no tools synthesized when upstream omits it" therefore still holds:
// the interior envelope carries no `tools`, and egress states `[]` on the way
// out. `ResponseResource` types `tools`, `tool_choice`, `truncation`,
// `temperature`, `service_tier` and ten others required AND non-nullable, so
// there is no spec-conformant way to say "the backend decided" — the choice is
// between a stated default and a body that fails validation.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2691-L2723

// A required slot with no `null` alternative: `null` and `undefined` both mean
// "absent", and the schema gives absence no spelling, so a stated default
// terminates the chain.
const stated = <T>(candidates: readonly (T | null | undefined)[], fallback: T): T =>
  candidates.find(value => value !== undefined && value !== null) ?? fallback;

// A required slot with a `null` alternative: `null` is an observation, so only
// `undefined` continues the chain and the chain's own end is `null`.
const observed = <T>(candidates: readonly (T | null | undefined)[]): T | null => {
  const hit = candidates.find(value => value !== undefined);
  return hit === undefined ? null : hit;
};

// The normalizers run on the RESOLVED value, so an upstream-echoed or
// shim-reconstructed object is completed exactly like one built from the
// request.

// A function tool must declare `description`, `parameters` and `strict` even
// when the client omitted them: all three are required-with-a-`null`-alternative
// on the response tool schema while the request schema leaves them optional. An
// absent key becomes `null` rather than an invented `{}` / `false`, because the
// caller expressed no choice and the upstream owns the effective default.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2141-L2192
const completeTool = (tool: ResponsesTool): ClientResponsesTool =>
  tool.type !== 'function'
    ? tool
    : {
        ...tool,
        description: tool.description ?? null,
        parameters: tool.parameters ?? null,
        strict: tool.strict ?? null,
      };

// `TextField` requires `format`, whose own default is plain text.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2298-L2319
const completeText = (text: NonNullable<ResponsesResult['text']>): ClientResponsesTextField =>
  ({ ...text, format: text.format ?? { type: 'text' } });

// `Reasoning` requires `effort` and `summary`, both of which are nullable, so
// an unconfigured reasoning object says so rather than naming a level.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2320-L2359
const completeReasoning = (reasoning: NonNullable<ResponsesResult['reasoning']> | null): ClientResponsesReasoning | null =>
  reasoning === null ? null : { ...reasoning, effort: reasoning.effort ?? null, summary: reasoning.summary ?? null };

// Both breakdowns are required whenever `usage` itself is an object. An absent
// breakdown means the upstream reported no cached input tokens and no reasoning
// output tokens.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2384-L2429
const completeUsage = (usage: NonNullable<ResponsesResult['usage']> | null): ClientResponsesUsage | null =>
  usage === null
    ? null
    : {
        ...usage,
        input_tokens_details: usage.input_tokens_details ?? { cached_tokens: 0 },
        output_tokens_details: usage.output_tokens_details ?? { reasoning_tokens: 0 },
      };

export interface ResponsesEnvelopeSources {
  // The request these events answer. Every echoed value comes from here.
  readonly request: CanonicalResponsesPayload;
  // Unix seconds. One value per response, so every envelope frame of a single
  // response reports the same `created_at`.
  readonly createdAt: number;
  // Whether the response is actually retrievable afterwards, which is what the
  // schema's `store` describes ("Whether this response was stored so it can be
  // retrieved later"). Sourced from the item store rather than the request's
  // `store` flag, because retention policy and the WebSocket session's
  // connection-local history both override what the client asked for.
  readonly stored: boolean;
}

// Every description the response resource attaches to these keys is past
// tense — "The tools that were available to the model during response
// generation", "The service tier that was used for this response", "How the
// input was truncated by the service". The resource states what happened, not
// what was asked, so an upstream that reports an effective value outranks the
// request; where the upstream reports nothing, the request's own value is the
// best available statement about the turn; where neither exists the schema
// forces a stated default.
//
// The stated defaults are the values OpenAI's own reference response body
// reports for a request that specified none of them.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2726-L2778
// The request-side declarations of the same defaults:
// temperature 1 and top_p 1 — https://github.com/openai/openai-openapi/blob/db14b6e1712aaf5265cf5a6871adff7a9c61d31c/openapi.yaml#L44081-L44100
// truncation "disabled" — https://github.com/openai/openai-openapi/blob/db14b6e1712aaf5265cf5a6871adff7a9c61d31c/openapi.yaml#L35856-L35873
// parallel_tool_calls true — https://github.com/openai/openai-openapi/blob/db14b6e1712aaf5265cf5a6871adff7a9c61d31c/openapi.yaml#L35915-L35921
// background false — https://github.com/openai/openai-openapi/blob/db14b6e1712aaf5265cf5a6871adff7a9c61d31c/openapi.yaml#L59062-L59068
// presence_penalty 0 — https://github.com/openai/openai-openapi/blob/db14b6e1712aaf5265cf5a6871adff7a9c61d31c/openapi.yaml#L33561-L33565
// frequency_penalty 0 — https://github.com/openai/openai-openapi/blob/db14b6e1712aaf5265cf5a6871adff7a9c61d31c/openapi.yaml#L33484-L33488
// tool_choice "auto" — https://github.com/openai/openai-openapi/blob/db14b6e1712aaf5265cf5a6871adff7a9c61d31c/openapi.yaml#L62038-L62058
// service_tier: the request-side default is "auto", but the response reports
// the tier that was actually used, which for an account with no tier configured
// is "default" — the value the reference body carries.
// https://github.com/openai/openai-openapi/blob/db14b6e1712aaf5265cf5a6871adff7a9c61d31c/openapi.yaml#L61500-L61518
export const completeResponsesEnvelope = (
  upstream: ResponsesResult,
  sources: ResponsesEnvelopeSources,
  terminal: boolean,
): ClientResponsesEnvelope => {
  const { request } = sources;
  return {
    // The keys the upstream owns outright — `id`, `object`, `model`, `status`,
    // `output`, `output_text` — plus any vendor extension it carried ride
    // through. Every key the resource declares required is resolved explicitly
    // below, so nothing in this spread is load-bearing for conformance.
    ...upstream,

    // Gateway state: no candidate chain, because no other source can know it.
    created_at: sources.createdAt,
    completed_at: terminal ? Math.floor(Date.now() / 1000) : null,
    store: sources.stored,

    tools: stated<ResponsesTool[]>([upstream.tools, request.tools], []).map(completeTool),
    tool_choice: stated([upstream.tool_choice, request.tool_choice], 'auto'),
    truncation: stated([upstream.truncation, request.truncation], 'disabled'),
    parallel_tool_calls: stated([upstream.parallel_tool_calls, request.parallel_tool_calls], true),
    text: completeText(stated<NonNullable<ResponsesResult['text']>>([upstream.text, request.text], {})),
    top_p: stated([upstream.top_p, request.top_p], 1),
    presence_penalty: stated([upstream.presence_penalty, request.presence_penalty], 0),
    frequency_penalty: stated([upstream.frequency_penalty, request.frequency_penalty], 0),
    top_logprobs: stated([upstream.top_logprobs, request.top_logprobs], 0),
    temperature: stated([upstream.temperature, request.temperature], 1),
    background: stated([upstream.background, request.background], false),
    service_tier: stated([upstream.service_tier, request.service_tier], 'default'),
    metadata: stated<Record<string, unknown>>([upstream.metadata, request.metadata], {}),

    previous_response_id: observed([upstream.previous_response_id, request.previous_response_id]),
    instructions: observed([upstream.instructions, request.instructions]),
    max_output_tokens: observed([upstream.max_output_tokens, request.max_output_tokens]),
    max_tool_calls: observed([upstream.max_tool_calls, request.max_tool_calls]),
    safety_identifier: observed([upstream.safety_identifier, request.safety_identifier]),
    prompt_cache_key: observed([upstream.prompt_cache_key, request.prompt_cache_key]),
    reasoning: completeReasoning(observed<NonNullable<ResponsesResult['reasoning']>>([upstream.reasoning, request.reasoning])),
    // The request has no counterpart: token counts are the upstream's alone.
    usage: completeUsage(observed([upstream.usage])),
  };
};

// The client-facing egress stage: every envelope-bearing event carries the
// complete resource, so a streamed response validates frame by frame and the
// non-streaming body — which is the terminal frame's envelope verbatim —
// validates too. The narrowed yield type propagates the guarantee, so a stage
// inserted between this one and a client-facing exit must preserve it or fail
// to compile.
export const wrapResponsesEnvelopeCompletion = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  sources: ResponsesEnvelopeSources,
): AsyncGenerator<ProtocolFrame<ClientResponsesStreamEvent>> {
  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const event = frame.event;
    switch (event.type) {
    case 'response.queued':
    case 'response.created':
    case 'response.in_progress':
      yield eventFrame({ ...event, response: completeResponsesEnvelope(event.response, sources, false) });
      continue;
    case 'response.completed':
    case 'response.incomplete':
    case 'response.failed':
      yield eventFrame({ ...event, response: completeResponsesEnvelope(event.response, sources, true) });
      continue;
    default:
      yield eventFrame(event);
    }
  }
};

// `/responses/compact` answers with `CompactResource`, which requires `id`,
// `object`, `output`, `created_at` and `usage` and declares none of the
// response resource's request echoes. Running the response resource's
// completion over it would decorate a compaction with `temperature`, `tools`
// and twenty other keys its own resource does not define, so the compact route
// gets its own short completion instead.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json  (components.schemas.CompactResource)
//
// `model`, `status`, `error` and `incomplete_details` ride through from the
// trigger turn. `CompactResource` does not define them and the spec does not
// forbid extras, so they are kept: dropping a field a client may already read
// is a user-visible removal, and there is nothing to gain from it.
export const completeResponsesCompaction = (
  upstream: ResponsesResult,
  createdAt: number,
): ClientResponsesCompaction => ({
  ...upstream,
  object: 'response.compaction',
  created_at: createdAt,
  usage: completeUsage(observed([upstream.usage])),
});
