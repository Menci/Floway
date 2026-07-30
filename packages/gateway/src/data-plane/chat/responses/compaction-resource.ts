import { completeUsage } from './response-resource.ts';
import type { ClientResponsesCompaction, ResponsesResult } from '@floway-dev/protocols/responses';

// `Usage` requires the three totals, and this resource's slot has no `null`
// alternative, so an upstream that reported no token counts — `usage` absent,
// or `null`, which this protocol treats as that same report — has no spelling
// on this wire.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2384-L2429
//
// Zeros are not that spelling. A compaction is a turn a model actually ran, so
// zero totals are never a true statement about one, and a client reading them
// as the turn's cost would be reading a number Floway invented. The absence is
// also not ours to paper over: no stage between the provider and this line
// drops a count — the compact route's round trip through item persistence puts
// the whole result on the terminal event and reassembles that object verbatim,
// rewriting only `id`, and the shim's synthesized envelope spreads its
// summarization turn. So an upstream that states nothing here has left us
// unable to answer, and that is what gets reported.
const missingUsage = (): never => {
  throw new TypeError('Responses compaction upstream reported no token usage; the compaction resource requires it');
};

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
  usage: completeUsage(upstream.usage ?? missingUsage()),
});
