import { completeUsage } from './response-resource.ts';
import type { ClientResponsesCompaction, ResponsesResult } from '@floway-dev/protocols/responses';

// `Usage` requires the three totals as well as both breakdowns, and this
// resource's slot has no `null` alternative, so an upstream that reported no
// token counts — `usage` absent, or `null`, which this protocol treats as that
// same report — has no spelling on this wire and the totals are stated as zero.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2384-L2429
//
// Zero here always means the upstream said nothing, never that Floway lost the
// count. No stage between the provider and this line drops it: the compact
// route's round trip through item persistence puts the whole result on the
// terminal event and reassembles that object verbatim, rewriting only `id`, and
// the shim's synthesized envelope spreads its summarization turn. Absence is
// the upstream's own, on either of two routes: a native Responses upstream may
// report no counts on a compaction, and `responses-via-chat-completions` emits
// `usage` only from a usage chunk it actually received, so a chat upstream that
// ignores the `stream_options.include_usage` the gateway forces on every call
// leaves none. That second silence empties `billableUsage` too, which reads the
// same chunk, so the wire and the bill agree on it.
const NO_TOKENS_REPORTED = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

// Completing a compaction with `completeResponseResource` would decorate it
// with `temperature`, `tools`, `truncation`, `service_tier`, `store` and the
// twenty-one further keys `ResponseResource` requires and `CompactResource`
// does not declare, so the compact route completes its own five instead.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L3935-L4008
//
// `id` carries the response id the stateful boundary minted; `output` is the
// upstream's own compacted list. `object` is restated because `ResponsesResult`
// types it as a bare `string`, and the literal is what satisfies the enum the
// compaction resource pins. The spread keeps every other key the upstream sent:
// dropping a field a client may already read is a user-visible removal with
// nothing to gain.
export const completeResponsesCompaction = (
  upstream: ResponsesResult,
  createdAt: number,
): ClientResponsesCompaction => ({
  ...upstream,
  object: 'response.compaction',
  created_at: createdAt,
  usage: completeUsage(upstream.usage ?? NO_TOKENS_REPORTED),
});
