import { containsCompactionTrigger } from './compact-shim.ts';
import type { CompactionAsk } from './summarize-for-compaction.ts';
import { openaiResponsesTarget } from './target.ts';
import type { AttemptSelector } from '../../pipeline/facts.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ModelCandidate } from '@floway-dev/provider';

// ── The compact shim ──────────────────────────────────────────────────────────────────────
//
// Two rules, composed by both of this protocol's chains, because a compaction the shim wrote
// is issued through one entry and read back through the other: Codex asks for one by ending
// a generate turn's input with a `compaction_trigger`, `/v1/responses/compact` asks for one
// by being called at all, and either way the envelope comes back to the client, who echoes it
// into the ordinary turns that follow. What the shim is, what it vendors and what it cannot
// reproduce is at `compact-shim.ts`.

/**
 * Whether this candidate's compactions are the shim's to simulate.
 *
 * Two ways to be, and an upstream only has to be one of them. The operator opted an OpenAI Responses
 * upstream in with `openai-responses-compact-shim`, which is the say-so for one that would answer a
 * compaction itself. Or the candidate has no OpenAI Responses endpoint at all: no translation
 * carries a compaction, so an Anthropic Messages or OpenAI Chat Completions candidate has neither a compaction
 * to dial nor a translator that models the item asking for one — the shim is structurally
 * required there rather than chosen.
 *
 * One reading, taken wherever the question is asked, so a turn that asks for a compaction on
 * its way through generation is answered with the compaction this protocol's own endpoint
 * would have produced for it.
 */
export const simulatesCompaction = (candidate: ModelCandidate, attempt: AttemptSelector): boolean =>
  openaiResponsesTarget.pick(candidate.model.endpoints) !== 'openaiResponses'
  || attempt.flags.includes('openai-responses-compact-shim');

/**
 * What asking for a compaction looks like on this chain.
 *
 * Codex's RemoteCompactionV2 path asks for one inside an ordinary turn, by ending its input
 * with the control item that requests it — so this chain reads the request rather than the
 * operation, and reads it per turn. Where the shim is not this candidate's to run, the item
 * travels on to an upstream whose own `/responses` endpoint answers it, which is what a
 * native OpenAI Responses upstream does with it.
 */
export const asksForCompaction: CompactionAsk = (facts, use) =>
  containsCompactionTrigger((facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload).input)
  && simulatesCompaction(use.resolveAttempt(facts['route.attempt']), facts['route.attempt']);
