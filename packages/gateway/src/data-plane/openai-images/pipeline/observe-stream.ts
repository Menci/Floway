import type { UsageObserver } from '../../pipeline/compute-usage.ts';
import type { StreamVerdict } from '../../pipeline/protocol-outcome.ts';
import { measureOpenAIImagesUsage } from '../usage.ts';
import { isOpenAIImagesCompletedEvent, type OpenAIImagesStreamEvent } from '@floway-dev/protocols/openai-images';

export const openAIImagesVerdict = (event: OpenAIImagesStreamEvent): StreamVerdict | undefined =>
  event.type === 'error' ? 'failure' : isOpenAIImagesCompletedEvent(event) ? 'complete' : undefined;

export const openAIImagesUsage: UsageObserver<'response.openaiImagesEdits' | 'response.openaiImagesGenerations'> = {
  kind: 'billable',
  result: measureOpenAIImagesUsage,
  stream: () => ({
    observe: event => isOpenAIImagesCompletedEvent(event) ? measureOpenAIImagesUsage(event) : null,
    finish: () => null,
  }),
};
