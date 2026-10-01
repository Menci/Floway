import type { Fields, Counted } from './facts.ts';
import { asJsonObject, readJsonNumber } from '../../../../shared/json-helpers.ts';
import { isFailure } from '../../../pipeline/facts.ts';
import type { TokenCountAnswer } from '../../anthropic-messages/count-tokens/facts.ts';
import type { ChatServices } from '../../services.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { translateGeminiGenerateContentViaAnthropicMessages, TranslatorInputError } from '@floway-dev/translate';

/**
 * Asks the question in Anthropic Messages, and reads the answer back out as Google's.
 *
 * It consumes this protocol's request key and provides the target's, exactly as a handoff
 * does, so the wire below sees only Anthropic Messages and cannot tell it was reached by translation.
 * What differs is the way back: there are no frames to map, only counts.
 *
 * It carries the `return` trait for the same reason a handoff does — a body the target
 * protocol cannot represent is answered here rather than measured.
 */
export const measureGeminiGenerateContentAsAnthropicMessages = defineStage<
  Fields<'request.chat.geminiGenerateContent' | 'route.attempt'>,
  Fields<'request.chat.anthropicMessages'>,
  Counted<'response.chat.anthropicMessages'>,
  Counted<'response.chat.geminiGenerateContent'>,
  Counted<'response.chat.geminiGenerateContent'> & Fields<'response.usage.billable' | 'response.http.headers' | 'response.http.body' | 'response.http.status'>,
  ChatServices
>({
  name: 'measureGeminiGenerateContentAsAnthropicMessages',
  through: {
    request: {
      needs: ['request.chat.geminiGenerateContent', 'route.attempt'],
      consumes: ['request.chat.geminiGenerateContent'],
      provides: ['request.chat.anthropicMessages'],
    },
    response: {
      needs: ['response.chat.anthropicMessages'],
      consumes: ['response.chat.anthropicMessages'],
      provides: ['response.chat.geminiGenerateContent'],
    },
  },
  return: { provides: ['response.chat.geminiGenerateContent', 'response.usage.billable', 'response.http.headers', 'response.http.body', 'response.http.status'] },
  execute: async (facts, next, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    const { 'request.chat.geminiGenerateContent': asked, ...down } = facts;

    let trip;
    try {
      trip = await translateGeminiGenerateContentViaAnthropicMessages(asked, {
        model: candidate.model.id,
        fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
      });
    } catch (error) {
      // Input the counting wire's protocol cannot represent is the client's fault, and the
      // translator is what knows which part of the body was at fault. Answering rather than
      // throwing is also what keeps it a *candidate's* verdict, so the fork can try the next
      // one. Anything else raised here is a fault of this gateway's and rides up as one.
      if (!(error instanceof TranslatorInputError)) throw error;
      return move({
        ...down,
        'response.chat.geminiGenerateContent': { status: 400, message: error.message },
        // Nothing was measured, which is what an empty billed set and an empty header list say
        // on the other two keys. There is no streamed reading to leave behind: a measurement
        // never opens a stream, which is why this chain carries no such key at all.
        'response.usage.billable': [],
        'response.http.headers': [],
        'response.http.body': null, 'response.http.status': 400,
      });
    }

    // The translator writes a turn, and a turn says how its answer is delivered. There is no
    // answer to deliver here, so the field does not travel.
    const { stream: _stream, ...target } = trip.target;

    const back = await next({ ...down, 'request.chat.anthropicMessages': move(target) });
    const { 'response.chat.anthropicMessages': counted, ...up } = back;
    return { ...up, 'response.chat.geminiGenerateContent': move(asGeminiGenerateContentTokenCount(counted)) };
  },
});

/**
 * Anthropic's counts, as Google states them.
 *
 * The upstream body is provider-specific: Anthropic's own endpoint answers `input_tokens`,
 * and a Copilot upstream's translated count answers `total_tokens`. Either is the number this
 * protocol calls `totalTokens`; a body carrying neither is an answer this gateway cannot
 * read, which is the gateway failing to serve rather than anything the client can fix.
 */
const asGeminiGenerateContentTokenCount = (counted: TokenCountAnswer): TokenCountAnswer => {
  if (isFailure(counted)) {
    return {
      ...counted,
      // An upstream that refused with an empty body left nothing to quote, and a refusal that
      // says nothing at all is not one a caller can act on.
      message: counted.message === '' ? 'Upstream token counting request failed.' : counted.message,
    };
  }
  const body = asJsonObject(counted.body);
  const totalTokens = readJsonNumber(body?.input_tokens) ?? readJsonNumber(body?.total_tokens);
  if (totalTokens === null) return { status: 502, message: 'Invalid upstream token counting response.' };
  return { kind: 'value', body: { totalTokens } };
};
