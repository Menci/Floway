import type { ResponsesFunctionTool, ResponsesResult, ResponsesStreamEvent, ResponsesTool } from './index.ts';

// The shape a client-facing Responses body must have, derived from
// `ResponsesResult` rather than restated beside it. `ResponsesResult` models
// four things at once — what an arbitrary upstream sent, what a translator
// assembles mid-stream, what reaches a client, and (under
// `object: 'response.compaction'`) a different resource entirely — so its
// resource keys are optional. Only the client-facing role has to satisfy
// `ResponseResource.required`, and only at the last stage before
// serialization.
//
// Deriving means the two cannot drift: a field added to `ResponsesResult`
// widens these types automatically. The only hand-maintained artefacts are the
// two key unions below, which transcribe the schema and change when it does.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2691-L2723
//
// `ResponseResource.required` lists 31 keys. Seven of them (`id`, `object`,
// `model`, `output`, `status`, `error`, `incomplete_details`) are already
// non-optional on `ResponsesResult`. The remaining 24 are split below by the
// single bit that decides how an absent value may be spelled on the wire:
// whether the slot carries a `null` alternative.

// Required with no `null` alternative: absence has no spelling at all, so a
// value must be stated.
type ResponseResourceStatedKey =
  | 'created_at'
  | 'tools'
  | 'tool_choice'
  | 'truncation'
  | 'parallel_tool_calls'
  | 'text'
  | 'top_p'
  | 'presence_penalty'
  | 'frequency_penalty'
  | 'top_logprobs'
  | 'temperature'
  | 'store'
  | 'background'
  | 'service_tier'
  | 'metadata';

// Required with a `null` alternative: `null` IS the schema's spelling for
// absence, so nothing has to be invented — only present.
type ResponseResourceNullableKey =
  | 'completed_at'
  | 'previous_response_id'
  | 'instructions'
  | 'reasoning'
  | 'usage'
  | 'max_output_tokens'
  | 'max_tool_calls'
  | 'safety_identifier'
  | 'prompt_cache_key';

// `Usage` requires both breakdowns whenever it is an object.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2384-L2429
type ResponsesUsage = NonNullable<ResponsesResult['usage']>;
export type ClientResponsesUsage =
  Omit<ResponsesUsage, 'input_tokens_details' | 'output_tokens_details'>
  & Required<Pick<ResponsesUsage, 'input_tokens_details' | 'output_tokens_details'>>;

// `TextField` requires `format`.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2298-L2319
type ResponsesTextField = NonNullable<ResponsesResult['text']>;
export type ClientResponsesTextField = ResponsesTextField & Required<Pick<ResponsesTextField, 'format'>>;

// `Reasoning` requires `effort` and `summary`.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2320-L2359
type ResponsesReasoning = NonNullable<ResponsesResult['reasoning']>;
export type ClientResponsesReasoning = ResponsesReasoning & Required<Pick<ResponsesReasoning, 'effort' | 'summary'>>;

// `FunctionTool` requires `description`, `parameters` and `strict` on the
// response side while the request side leaves all three optional. Distributive
// so every other member of the tool union passes through unchanged and the
// union stays discriminable on `type`.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2141-L2192
export type ClientResponsesTool =
  ResponsesTool extends infer Tool
    ? Tool extends { type: 'function' }
      ? Tool & Required<Pick<ResponsesFunctionTool, 'description' | 'parameters' | 'strict'>>
      : Tool
    : never;

// Named for the schema's own `ResponseResource`, hence the singular `Response`
// where the protocol-shaped siblings above carry `Responses`.
//
// `-?` preserves declared nullability, which is exactly the distinction the two
// key unions draw: a stated key wrapped in `NonNullable` becomes present and
// non-null, a nullable key becomes present and possibly null.
export type ClientResponseResource =
  Omit<ResponsesResult, ResponseResourceStatedKey | ResponseResourceNullableKey>
  & { [K in ResponseResourceStatedKey]-?: NonNullable<ResponsesResult[K]> }
  & { [K in ResponseResourceNullableKey]-?: ResponsesResult[K] | null }
  & {
    tools: ClientResponsesTool[];
    text: ClientResponsesTextField;
    reasoning: ClientResponsesReasoning | null;
    usage: ClientResponsesUsage | null;
  };

// `/responses/compact` answers with a resource of its own. `CompactResource`
// requires `id`, `object`, `output`, `created_at` and `usage` — five keys, none
// of them a request echo. `object` and `usage` are the two keys the two
// resources spell differently: the enum value changes, and `ResponseResource`
// gives `usage` a `null` alternative where this one does not, so a compaction
// must state token counts. The schema forbids no extras, so keys the upstream
// sent beyond these ride through.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L3935-L4008
export type ClientResponsesCompaction =
  Omit<ResponsesResult, 'object' | 'created_at' | 'usage'>
  & Required<Pick<ResponsesResult, 'created_at'>>
  & { object: 'response.compaction'; usage: ClientResponsesUsage };

// Every resource-bearing member of the stream union, re-declared with the
// completed resource. Distributive so each member keeps its `type` literal.
// A `response.*` event added to `ResponsesStreamEvent` is narrowed
// automatically.
type WithClientResource<Event> = Event extends { response: ResponsesResult }
  ? Omit<Event, 'response'> & { response: ClientResponseResource }
  : Event;

export type ClientResponsesStreamEvent = WithClientResource<ResponsesStreamEvent>;
