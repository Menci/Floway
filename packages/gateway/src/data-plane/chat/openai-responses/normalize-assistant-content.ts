import type { Fields } from './facts.ts';
import type { ChatServices } from '../services.ts';
import { normalizeAssistantInputText } from './items/normalize-assistant-content.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

/**
 * What an upstream's OpenAI Responses endpoint accepts on an assistant item it produced itself.
 * Copilot's compaction translation and Azure-native compaction both emit assistant messages
 * whose content blocks carry `type: 'input_text'`, and both then refuse those same items
 * echoed back as input on the next turn. Every way prior upstream-produced history reaches a
 * wire arrives here — a direct client echo, the snapshot the membrane expanded, a compaction
 * tail — so this is the one place the canonical assistant content type is put back.
 *
 * Only this wire needs it. Both translators read `input_text` and `output_text` the same way
 * on assistant content, so a turn that leaves for Anthropic Messages or OpenAI Chat Completions never carried
 * the disagreement in the first place.
 */
export const normalizeAssistantContentForOpenAIResponses = defineStage<
  Fields<'request.chat.openaiResponses'>,
  Fields<'request.chat.openaiResponses'>,
  Record<string, never>,
  Record<string, never>,
  ChatServices
>({
  name: 'normalizeAssistantContentForOpenAIResponses',
  through: {
    request: { needs: ['request.chat.openaiResponses'], consumes: [], provides: ['request.chat.openaiResponses'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    const payload = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
    const input = normalizeAssistantInputText(payload.input);
    // A rewrite that changed nothing hands the same payload on, so the record shows no
    // change where none happened.
    if (input === payload.input) return await next(facts);
    return await next({ ...facts, 'request.chat.openaiResponses': move({ ...payload, input }) });
  },
});
