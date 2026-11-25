import { geminiGenerateContentPayload, servesNativeGeminiGenerateContent } from './native-target.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

const { defineStage } = gatewayFactSpace<{}>();
const requestKey = 'request.geminiGenerateContent';
const responseKey = 'response.geminiGenerateContent';

export const suppressThoughtParts = defineStage({
  name: 'geminiGenerateContent.suppress-thought-parts',
  through: {
    request: { needs: [requestKey, 'serve.candidate'], provides: [], consumes: [] },
    response: { needs: [responseKey], provides: [responseKey], consumes: [] },
  },
  execute: transform(scope => {
    let enabled: boolean;
    return {
      request: facts => {
        enabled = !servesNativeGeminiGenerateContent(facts['serve.candidate'])
          && geminiGenerateContentPayload(facts[requestKey]).generationConfig?.thinkingConfig?.includeThoughts !== true;
        return facts;
      },
      response: facts => {
        const outcome = facts[responseKey];
        if (!enabled || outcome.kind !== 'stream') return facts;
        const stream = scope.wrapStream(outcome.stream, async function* (items) {
          for await (const item of items) {
            if (!item.ok) yield item;
            else {
              const event = withoutThoughtParts(item.value);
              if (event !== null) yield { ok: true, value: event };
            }
          }
        });
        return { ...facts, [responseKey]: move({ kind: 'stream', stream } as const) };
      },
    };
  }),
});

const withoutThoughtParts = (event: GeminiGenerateContentStreamEvent): GeminiGenerateContentStreamEvent | null => {
  if ('error' in event) return event;
  const candidates = event.candidates?.flatMap(candidate => {
    if (candidate.content?.parts === undefined) return [candidate];
    const parts = candidate.content.parts.filter(part => part.thought !== true);
    return parts.length === 0 && candidate.finishReason === undefined ? [] : [{ ...candidate, content: { ...candidate.content, parts } }];
  });
  if ((candidates?.length ?? 0) === 0 && event.usageMetadata === undefined && event.modelVersion === undefined
    && event.responseId === undefined && event.promptFeedback === undefined && event.modelStatus === undefined) return null;
  return { ...event, ...(candidates === undefined ? {} : { candidates }) };
};
