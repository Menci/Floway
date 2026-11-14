import { composeChat as compose } from '../../compose.ts';
import { dialChatWire } from '../../dial-wire.ts';
import type { ChatWire } from '../../wire.ts';
import { decryptNativeCompaction } from '../compact-decrypt.ts';
import { OPENAI_RESPONSES_STREAMED_USAGE } from '../facts.ts';
import { meterUsage } from '../meter.ts';
import { summarizeForCompaction } from '../summarize-for-compaction.ts';
import { openaiResponsesTarget } from '../target.ts';
import { openaiResponsesWireRules, openaiResponsesWire } from '../wire.ts';
import { openaiResponsesWireFor } from '../wires.ts';
import { callOpenAIResponsesCompactUpstream } from './call-upstream.ts';

/** The generate fork, as the simulation reaches it. A summarization is an ordinary turn, so
 *  it is dialled on the wires an ordinary turn is dialled on. */
const dialSummarizationWire = dialChatWire({
  source: 'request.chat.openaiResponses',
  needs: ['request.chat.openaiResponses', 'ingress.http.headers', 'ingress.chat.sourceProtocol'],
  provides: ['response.chat.openaiResponses', OPENAI_RESPONSES_STREAMED_USAGE, 'response.usage.billable', 'response.http.headers'],
  pick: endpoints => openaiResponsesTarget.pick(endpoints),
  wire: openaiResponsesWireFor,
});

const nativeCompactionWire: ChatWire = compose('openaiResponsesCompactNative', [meterUsage(OPENAI_RESPONSES_STREAMED_USAGE), ...openaiResponsesWireRules, callOpenAIResponsesCompactUpstream]);

export const compactionWire: ChatWire = compose('openaiResponsesCompactDecrypted', [decryptNativeCompaction({ native: nativeCompactionWire, replay: compose('openaiResponsesCompactReplay', openaiResponsesWire(OPENAI_RESPONSES_STREAMED_USAGE)), streamedUsage: OPENAI_RESPONSES_STREAMED_USAGE, compactEndpoint: true, asked: () => true })]);

// The ending below picks this wire only for a candidate whose compactions are the shim's to
// simulate, so the ask is already answered: every turn that reaches it is one to summarize.
export const simulationWire: ChatWire = compose('openaiResponsesCompactSimulated', [summarizeForCompaction(() => true), dialSummarizationWire]);
