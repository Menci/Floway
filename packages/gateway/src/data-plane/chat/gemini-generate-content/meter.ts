import type { StreamOutcome } from '../../pipeline/serve.ts';
import { meterChatWire } from '../meter.ts';
import { chatUsageMeasurement, type ChatBillableUsage } from '../shared/usage.ts';
import { defer } from '@floway-dev/pipeline';
import { billableUsageFromGeminiGenerateContentEvent, type GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

export const meterGeminiGenerateContent = (streamedUsage: string) => meterChatWire<GeminiGenerateContentStreamEvent>({
  wire: 'geminiGenerateContent',
  answer: 'response.chat.geminiGenerateContent',
  streamedUsage,
  read: (source, identity) => {
    const completion = Promise.withResolvers<StreamOutcome>();
    const frames = (async function* () {
      let usage: ChatBillableUsage | null = null;
      let failed = true;
      try {
        for await (const frame of source) {
          if (frame.type === 'event') {
            if ('error' in frame.event) {
              yield frame;
              return;
            }
            usage = billableUsageFromGeminiGenerateContentEvent(frame.event) ?? usage;
          }
          yield frame;
        }
        failed = false;
      } finally {
        try {
          const measurement = usage === null ? null : chatUsageMeasurement(usage);
          completion.resolve({
            billable: [measurement === null ? { identity, quantities: {} }
              : { identity, quantities: measurement.quantities, pricingFacts: measurement.pricingFacts }],
            failed,
          });
        } catch (error) {
          completion.reject(error);
          throw error;
        }
      }
    })();
    return { frames: { [Symbol.asyncIterator]: () => frames }, outcome: defer(completion.promise) };
  },
});
