import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import { createGeminiGenerateContentCandidateCompletion, GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE, isGeminiGenerateContentTerminalEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { ProtocolStreamError } from '@floway-dev/provider';

const { defineStage } = gatewayFactSpace<{}>();
const key = 'response.geminiGenerateContent';

export const verifyStreamCompletion = defineStage({
  name: 'geminiGenerateContent.verify-stream-completion',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: [key], provides: [key], consumes: [] },
  },
  execute: transform(scope => ({
    response: facts => {
      const outcome = facts[key];
      if (outcome.kind !== 'stream') return facts;
      const stream = scope.wrapStream(outcome.stream, async function* (items, { signal }) {
        const completion = createGeminiGenerateContentCandidateCompletion();
        let terminal = false;
        for await (const item of items) {
          if (item.ok) {
            terminal ||= isGeminiGenerateContentTerminalEvent(item.value);
            completion.observe(item.value);
          } else terminal = true;
          yield item;
        }
        if (!terminal && !signal.aborted && !completion.isComplete()) yield {
          ok: false,
          error: {
            kind: 'protocol',
            cause: new Error(GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE),
          } satisfies ProtocolStreamError,
        };
      });
      return { ...facts, [key]: move({ kind: 'stream', stream } as const) };
    },
  })),
});
